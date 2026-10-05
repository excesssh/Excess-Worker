#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif
/* ABI 6 layout; compatible with distro headers older than the running kernel. */
struct excess_ruleset { uint64_t handled_access_fs, handled_access_net, scoped; };

/* Fail closed. This helper is a filesystem/network confinement profile, not a VM. */
static int phase;
static void fail(void) { fprintf(stderr,"RUNTIME_ISOLATION_UNAVAILABLE phase=%d errno=%d\n",phase,errno); exit(126); }
static uint64_t number(const char *s) {
    char *end; errno = 0; unsigned long long n = strtoull(s, &end, 10);
    if (errno || !*s || *end || s[0] == '-') fail(); return n;
}
static void path_rule(int rules, const char *path, uint64_t rights) {
    phase++;
    int fd = open(path, O_PATH | O_CLOEXEC); if (fd < 0) fail();
    struct stat st; if (fstat(fd, &st)) fail();
    if (!S_ISDIR(st.st_mode)) rights &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail(); close(fd);
}
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (n), 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM)
static void syscalls(void) {
    /* Deny process inspection, kernel control, child processes, UDP and Unix sockets.
       Threads remain available. clone3 gets ENOSYS so libc uses the checked clone path. */
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
        DENY(__NR_mount), DENY(__NR_umount2), DENY(__NR_pivot_root), DENY(__NR_chroot),
        DENY(__NR_bpf), DENY(__NR_perf_event_open), DENY(__NR_keyctl), DENY(__NR_add_key), DENY(__NR_request_key),
        DENY(__NR_open_by_handle_at), DENY(__NR_pidfd_getfd), DENY(__NR_unshare), DENY(__NR_setns),
        DENY(__NR_fork), DENY(__NR_vfork), DENY(__NR_io_uring_setup),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|ENOSYS),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_clone, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 7),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 2, 1, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 10, 0, 3),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 1, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
int main(int argc, char **argv) {
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (argc == 2 && !strcmp(argv[1], "--check")) {
        if (abi < 6) fail(); puts("linux-landlock-v1"); return 0;
    }
    /* helper <memory bytes> <seconds> <TCP bind port> <scratch> <read count> <read paths...> -- <executable> <args...> */
    if (argc < 9 || abi < 6 || getuid() == 0 || geteuid() == 0) fail();
    uint64_t memory = number(argv[1]), seconds = number(argv[2]), port = number(argv[3]), count = number(argv[5]);
    if (memory < 64*1024*1024 || seconds < 1 || seconds > 3600 || port < 1024 || port > 65535 || count > 64 || (uint64_t)argc < 8+count) fail();
    int command = 7 + count; if (strcmp(argv[command-1], "--")) fail();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) fail();
    struct rlimit mem = { memory, memory }, cpu = { seconds, seconds }, files = { 256, 256 }, core = { 0, 0 };
    if (setrlimit(RLIMIT_AS, &mem) || setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) fail();
    uint64_t read = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    uint64_t write = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
    struct excess_ruleset attr = { .handled_access_fs = (1ULL << 16) - 1,
        .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
        .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL };
    phase=10; int rules = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0); if (rules < 0) fail();
    const char *libraries[] = { "/usr/lib", "/lib", "/lib64", "/etc/ld.so.cache", "/proc/cpuinfo", "/proc/meminfo", "/sys/devices/system/cpu" };
    for (size_t n = 0; n < sizeof(libraries)/sizeof(libraries[0]); n++) if (!access(libraries[n], F_OK)) path_rule(rules, libraries[n], read);
    path_rule(rules, "/lib64/ld-linux-x86-64.so.2", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    path_rule(rules, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
    path_rule(rules, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);
    for (uint64_t n = 0; n < count; n++) path_rule(rules, argv[6+n], read);
    path_rule(rules, argv[command], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    path_rule(rules, argv[4], read | write);
    struct landlock_net_port_attr network = { .allowed_access = LANDLOCK_ACCESS_NET_BIND_TCP, .port = port };
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_NET_PORT, &network, 0) || syscall(SYS_landlock_restrict_self, rules, 0)) fail(); close(rules);
    phase=30; if (chdir(argv[4])) fail();
    if (setenv("HOME", argv[4], 1) || setenv("TMPDIR", argv[4], 1)) fail();
    /* No inherited host file handles beyond stdio. */
    syscall(SYS_close_range, 3, ~0U, 0);
    syscalls(); phase=31; execv(argv[command], &argv[command]); fail();
}
