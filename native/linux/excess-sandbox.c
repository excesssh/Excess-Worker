#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifdef EXCESS_GPU_PROFILE
#include <linux/memfd.h>
#define EXCESS_GPU_PRELOAD_FD 200
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
/* ABI 6 layout; compatible with distro headers older than the running kernel. */
struct excess_ruleset { uint64_t handled_access_fs, handled_access_net, scoped; };

/* Fail closed. This helper is a filesystem/network confinement profile, not a VM. */
static int phase;
#ifdef EXCESS_GPU_PROFILE
void excess_gpu_preflight_failure(void);
#endif
static _Noreturn void fail(void) {
#ifdef EXCESS_GPU_PROFILE
    excess_gpu_preflight_failure();
#endif
    fprintf(stderr,"RUNTIME_ISOLATION_UNAVAILABLE phase=%d errno=%d\n",phase,errno); exit(126);
}
static uint64_t number(const char *s) {
    char *end; errno = 0; unsigned long long n = strtoull(s, &end, 10);
    if (errno || !*s || *end || s[0] == '-') fail(); return n;
}
static void path_rule(int rules, const char *path, uint64_t rights) {
    phase++;
    int fd = open(path, O_PATH | O_CLOEXEC); if (fd < 0) fail();
    struct stat st; if (fstat(fd, &st)) fail();
    if (!S_ISDIR(st.st_mode)) rights &= LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV;
    struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail(); close(fd);
}
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (n), 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM)
#define MAX_MODELS 32
static void syscalls(void) {
    /* Deny process inspection, kernel control, child processes and UDP.
       Threads remain available. clone3 gets ENOSYS so libc uses clone. */
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
        DENY(__NR_fork), DENY(__NR_vfork), DENY(__NR_io_uring_setup), DENY(__NR_socketpair),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|ENOSYS),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_clone, 0, 4),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, CLONE_THREAD, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
#ifdef EXCESS_GPU_PROFILE
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 15),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET, 8, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET6, 7, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_UNIX, 0, 9),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SOCK_SEQPACKET, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SOCK_STREAM, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
#else
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 7),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 2, 1, 0),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 10, 0, 3),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xf),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 1, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
#endif
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
#ifdef EXCESS_GPU_PROFILE
    /* NVIDIA 570 open-kernel escape numbers: initialization, local allocation,
       event and mapping operations. Configuration writes, I2C, registry,
       diagnostic, object import/export, generic transfer and sharing escapes
       are omitted. RM_CONTROL's pointer payload still exposes the shared
       driver API: this is a fixed trusted inference workload, not isolation
       for arbitrary hostile GPU code. UVM tooling and peer access are omitted. */
#define GPU_IOCTL(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (n), 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
    struct sock_filter driver[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_ioctl, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])+4),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        /* NVIDIA 580 NV_ESC_NUMA_INFO, exact read/write query encoding and
         * 560-byte structure. NV_ESC_SET_NUMA_STATUS remains denied. */
        GPU_IOCTL(0xc23046d7),
        /* Exact observed UVM operation numbers; encoded variants stay denied. */
        GPU_IOCTL(23), GPU_IOCTL(24),
        BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0xffff),
        GPU_IOCTL(0x4627), GPU_IOCTL(0x4628), GPU_IOCTL(0x4629), GPU_IOCTL(0x462a), GPU_IOCTL(0x462b), GPU_IOCTL(0x4634),
        GPU_IOCTL(0x464e), GPU_IOCTL(0x464f), GPU_IOCTL(0x4652), GPU_IOCTL(0x4654), GPU_IOCTL(0x4657), GPU_IOCTL(0x4658), GPU_IOCTL(0x4659), GPU_IOCTL(0x465e),
        GPU_IOCTL(0x46c8), GPU_IOCTL(0x46c9), GPU_IOCTL(0x46ce), GPU_IOCTL(0x46cf), GPU_IOCTL(0x46d1), GPU_IOCTL(0x46d2),
        GPU_IOCTL(0x46d4), GPU_IOCTL(0x46d5), GPU_IOCTL(0x46d6), GPU_IOCTL(0x46da),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
        GPU_IOCTL(0x541b), GPU_IOCTL(0x5421), GPU_IOCTL(0x30000001), GPU_IOCTL(0x30000002),
        GPU_IOCTL(1), GPU_IOCTL(2), GPU_IOCTL(3), GPU_IOCTL(4), GPU_IOCTL(5), GPU_IOCTL(6), GPU_IOCTL(7), GPU_IOCTL(10),
        GPU_IOCTL(20), GPU_IOCTL(21), GPU_IOCTL(22), GPU_IOCTL(25), GPU_IOCTL(26), GPU_IOCTL(27), GPU_IOCTL(28),
        GPU_IOCTL(33), GPU_IOCTL(34), GPU_IOCTL(35), GPU_IOCTL(37), GPU_IOCTL(38), GPU_IOCTL(39),
        GPU_IOCTL(42), GPU_IOCTL(43), GPU_IOCTL(44), GPU_IOCTL(45), GPU_IOCTL(46), GPU_IOCTL(47), GPU_IOCTL(51),
        GPU_IOCTL(65), GPU_IOCTL(66), GPU_IOCTL(68), GPU_IOCTL(69), GPU_IOCTL(70), GPU_IOCTL(71), GPU_IOCTL(72),
        GPU_IOCTL(73), GPU_IOCTL(74), GPU_IOCTL(75), GPU_IOCTL(80), GPU_IOCTL(81), GPU_IOCTL(82), GPU_IOCTL(83),
        GPU_IOCTL(84), GPU_IOCTL(85), GPU_IOCTL(2047),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    };
    struct sock_fprog gpu_program = { .len = sizeof(driver)/sizeof(driver[0]), .filter = driver };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &gpu_program)) fail();
#undef GPU_IOCTL
#endif
}
#ifdef EXCESS_GPU_PROFILE
static void gpu_metadata_rules(int rules) {
    /* Driver initialization reads only its own process metadata and these
     * non-secret kernel discovery values; never grant a general proc tree. */
    const char *paths[] = { "/proc/self/maps", "/proc/self/status", "/proc/devices", "/proc/sys/vm/mmap_min_addr" };
    for (size_t n = 0; n < sizeof(paths)/sizeof(paths[0]); n++)
        path_rule(rules, paths[n], LANDLOCK_ACCESS_FS_READ_FILE);
}

static void gpu_preload_policy(void) {
    const int required = F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL;
    int seals = fcntl(EXCESS_GPU_PRELOAD_FD, F_GET_SEALS);
    int flags = fcntl(EXCESS_GPU_PRELOAD_FD, F_GETFD);
    if (seals < 0 || (seals & required) != required || flags < 0 || (flags & FD_CLOEXEC)) fail();
    char path[64];
    if (snprintf(path, sizeof(path), "/proc/self/fd/%d", EXCESS_GPU_PRELOAD_FD) >= (int)sizeof(path)) fail();
    /* Anonymous memfds cannot receive Landlock path rules. The helper creates
     * only these authenticated bytes; immutable seals and fd retention apply. */
    if (setenv("LD_PRELOAD", path, 1) || unsetenv("LD_AUDIT")) fail();
}
#endif
int main(int argc, char **argv) {
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (argc == 2 && !strcmp(argv[1], "--check")) {
        if (abi < 6) fail(); puts("linux-landlock-v1"); return 0;
    }
    /* helper <memory> <seconds> <port> <scratch> <read-count> <read-paths...> <model-count> <model-paths...> -- <command> <args...> */
    phase=1;
    if (argc < 9 || abi < 6 || getuid() == 0 || geteuid() == 0) fail();
    uint64_t memory = number(argv[1]), seconds = number(argv[2]), port = number(argv[3]), count = number(argv[5]);
    if (memory < 64*1024*1024 || seconds < 1 || seconds > 3600 || port < 1024 || port > 65535 || count > 64 || (uint64_t)argc < 8+count) fail();
    phase=2;
    uint64_t model_count_at = 6 + count;
    if (model_count_at >= (uint64_t)argc) fail();
    uint64_t model_count = number(argv[model_count_at]);
    if (model_count > MAX_MODELS || (uint64_t)argc < 9 + count + model_count) fail();
    uint64_t model_paths_at = model_count_at + 1;
    int command = 8 + count + model_count;
    phase=3;
    if (strcmp(argv[command-1], "--")) fail();
    phase=4;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) fail();
    struct rlimit mem = { memory, memory }, cpu = { seconds, seconds }, files = { 256, 256 }, core = { 0, 0 };
#ifdef EXCESS_GPU_PROFILE
    /* CUDA reserves a large sparse address space. The enclosing dedicated
       cgroup provides the hard aggregate RAM ceiling; the trusted supervisor
       additionally samples aggregate cgroup memory and the entire device budget. */
    (void)mem;
    if (setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) fail();
#else
    if (setrlimit(RLIMIT_AS, &mem) || setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) fail();
#endif
    int model_fds[MAX_MODELS]; char model_proc[MAX_MODELS][64], model_alias[MAX_MODELS][PATH_MAX];
    uint64_t model_total = 0; int scratch_fd = open(argv[4], O_RDONLY | O_DIRECTORY | O_CLOEXEC); if (scratch_fd < 0) fail();
    for (uint64_t n = 0; n < model_count; n++) {
        const char *path = argv[model_paths_at+n], *base = strrchr(path, '/'); base = base ? base+1 : path;
        if (!*base || !strcmp(base, ".") || !strcmp(base, "..") || strlen(base) >= sizeof(model_alias[n])) fail();
        for (const char *c = base; *c; c++) if (!( (*c>='a'&&*c<='z') || (*c>='A'&&*c<='Z') || (*c>='0'&&*c<='9') || *c=='.' || *c=='_' || *c=='-' )) fail();
        for (uint64_t j = 0; j < n; j++) if (!strcmp(base, strrchr(argv[model_paths_at+j], '/') ? strrchr(argv[model_paths_at+j], '/')+1 : argv[model_paths_at+j])) fail();
        model_fds[n] = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (model_fds[n] < 0) fail();
        if (fcntl(model_fds[n], F_SETFD, 0)) fail();
        struct stat st; if (fstat(model_fds[n], &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || (uint64_t)st.st_size > memory-model_total) fail();
        model_total += (uint64_t)st.st_size;
        if (snprintf(model_proc[n], sizeof(model_proc[n]), "/proc/self/fd/%d", model_fds[n]) >= (int)sizeof(model_proc[n]) ||
            snprintf(model_alias[n], sizeof(model_alias[n]), "%s/%s", argv[4], base) >= (int)sizeof(model_alias[n])) fail();
        if (symlinkat(model_proc[n], scratch_fd, base)) fail();
    }
    close(scratch_fd);
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
    path_rule(rules, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE
#ifdef EXCESS_GPU_PROFILE
        | LANDLOCK_ACCESS_FS_TRUNCATE
#endif
    );
    path_rule(rules, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);
#ifdef EXCESS_GPU_PROFILE
    /* No render nodes, other GPU ordinals, UVM tooling or general /dev grant. */
    gpu_metadata_rules(rules);
    const char *gpu_devices[] = { "/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm" };
    for (size_t n = 0; n < sizeof(gpu_devices)/sizeof(gpu_devices[0]); n++)
        path_rule(rules, gpu_devices[n], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_IOCTL_DEV);
    if (!access("/proc/driver/nvidia", F_OK)) path_rule(rules, "/proc/driver/nvidia", read);
    gpu_preload_policy();
#endif
    for (uint64_t n = 0; n < count; n++) path_rule(rules, argv[6+n], read);
    for (uint64_t n = 0; n < model_count; n++) path_rule(rules, model_proc[n], LANDLOCK_ACCESS_FS_READ_FILE);
    path_rule(rules, argv[command], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    path_rule(rules, argv[4], read | write);
    struct landlock_net_port_attr network = { .allowed_access = LANDLOCK_ACCESS_NET_BIND_TCP, .port = port };
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_NET_PORT, &network, 0) || syscall(SYS_landlock_restrict_self, rules, 0)) fail(); close(rules);
    phase=30; if (chdir(argv[4])) fail();
    if (setenv("HOME", argv[4], 1) || setenv("TMPDIR", argv[4], 1)) fail();
    /* Retain only the exact selected, read-only model handles across exec. */
    unsigned int first = 3;
    for (uint64_t n = 0; n < model_count; n++) {
        unsigned int fd = (unsigned int)model_fds[n];
        if (fd > first && syscall(SYS_close_range, first, fd-1, 0)) fail();
        first = fd + 1;
    }
#ifdef EXCESS_GPU_PROFILE
    if (first > EXCESS_GPU_PRELOAD_FD) fail();
    if (first < EXCESS_GPU_PRELOAD_FD && syscall(SYS_close_range, first, EXCESS_GPU_PRELOAD_FD-1, 0)) fail();
    first = EXCESS_GPU_PRELOAD_FD + 1;
#endif
    if (syscall(SYS_close_range, first, ~0U, 0)) fail();
    for (int at = command + 1; at < argc; at++) for (uint64_t n = 0; n < model_count; n++)
        if (!strcmp(argv[at], argv[model_paths_at+n])) argv[at] = model_alias[n];
    syscalls(); phase=31; execv(argv[command], &argv[command]); fail();
}
