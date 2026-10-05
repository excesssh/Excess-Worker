#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/mount.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <limits.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Trusted bootstrap only. No optional unconstrained execution path.
 * The controller receives neutral mount aliases, no host directory descriptors,
 * a fresh PID namespace and loopback-only network namespace. FD3 is a bounded
 * startup handshake with the outside broker and is closed before exec. */
static int phase;
static volatile sig_atomic_t supervised_child;
static void forward_signal(int signal_number) {
    int saved = errno;
    if (supervised_child > 0) kill((pid_t)supervised_child, signal_number);
    errno = saved;
}
static void fail(void) {
    fprintf(stderr, "CONTROLLER_ISOLATION_UNAVAILABLE phase=%d errno=%d\n", phase, errno);
    _exit(126);
}
static void write_all(int fd, const char *bytes, size_t length) {
    while (length) {
        ssize_t done = write(fd, bytes, length);
        if (done < 0 && errno == EINTR) continue;
        if (done <= 0) fail();
        bytes += done; length -= (size_t)done;
    }
}
static void write_map(const char *path, const char *value) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) fail();
    write_all(fd, value, strlen(value));
    if (close(fd)) fail();
}
static int anchor(const char *path, mode_t type) {
    if (!path || path[0] != '/' || !strcmp(path, "/")) fail();
    struct open_how how = { .flags = O_PATH | O_CLOEXEC,
        .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int fd = (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how));
    struct stat info;
    if (fd < 0 || fstat(fd, &info) || (info.st_mode & S_IFMT) != type) fail();
    return fd;
}
static int refresh_anchor(int old_fd, const char *path, mode_t type) {
    int fd = anchor(path, type);
    struct stat old_info, info;
    if (fstat(old_fd, &old_info) || fstat(fd, &info) || old_info.st_dev != info.st_dev ||
        old_info.st_ino != info.st_ino || close(old_fd)) fail();
    return fd;
}
static void attributes(const char *path, int recursive, uint64_t flags) {
    struct mount_attr attr = { .attr_set = flags };
    if (syscall(SYS_mount_setattr, AT_FDCWD, path, recursive ? AT_RECURSIVE : 0,
        &attr, sizeof(attr))) fail();
}
static void make_dir(const char *root, const char *name, char target[PATH_MAX]) {
    if (snprintf(target, PATH_MAX, "%s%s", root, name) >= PATH_MAX || mkdir(target, 0700)) fail();
}
static void bind_fd(int fd, const char *target, int directory, uint64_t flags) {
    if (!directory) {
        int out = open(target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (out < 0 || close(out)) fail();
    }
    int tree = (int)syscall(SYS_open_tree, fd, "", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC |
        AT_EMPTY_PATH | (directory ? AT_RECURSIVE : 0));
    if (tree < 0 || syscall(SYS_move_mount, tree, "", AT_FDCWD, target, MOVE_MOUNT_F_EMPTY_PATH)) fail();
    if (close(tree)) fail();
    attributes(target, directory, flags);
}
static void bind_system(const char *root, const char *source, const char *alias, int directory, uint64_t flags) {
    char canonical[PATH_MAX], target[PATH_MAX];
    if (!realpath(source, canonical)) fail();
    int fd = anchor(canonical, directory ? S_IFDIR : S_IFREG);
    if (snprintf(target, PATH_MAX, "%s%s", root, alias) >= PATH_MAX) fail();
    if (directory && mkdir(target, 0700)) fail();
    bind_fd(fd, target, directory, flags); close(fd);
}
static void bind_store(int store, const char *root, const char *name, int optional, uint64_t flags) {
    struct open_how how = { .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    int fd = (int)syscall(SYS_openat2, store, name, &how, sizeof(how));
    if (fd < 0 && optional && errno == ENOENT) return;
    struct stat info;
    if (fd < 0 || fstat(fd, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 022)) fail();
    char alias[128], target[PATH_MAX];
    if (snprintf(alias, sizeof(alias), "/ai/%s", name) >= (int)sizeof(alias)) fail();
    make_dir(root, alias, target); bind_fd(fd, target, 1, flags); close(fd);
}
static void loopback(void) {
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    struct ifreq request; memset(&request, 0, sizeof(request));
    memcpy(request.ifr_name, "lo", 3);
    if (fd < 0 || ioctl(fd, SIOCGIFFLAGS, &request)) fail();
    request.ifr_flags |= IFF_UP;
    if (ioctl(fd, SIOCSIFFLAGS, &request) || close(fd)) fail();
}
static void drop_capabilities(void) {
    if (prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED |
        SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED |
        SECBIT_KEEP_CAPS_LOCKED | SECBIT_NO_CAP_AMBIENT_RAISE | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED)) fail();
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) fail();
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail();
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct data[2]; memset(data, 0, sizeof(data));
    if (syscall(SYS_capset, &header, data) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
}
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (n), 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
    /* Guardians need fork/exec and additional Landlock/seccomp filters. Deny
     * new namespaces, mount changes, host process inspection and kernel APIs. */
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY(__NR_mount), DENY(__NR_umount2), DENY(__NR_pivot_root), DENY(__NR_chroot),
        DENY(__NR_mount_setattr), DENY(__NR_open_tree), DENY(__NR_move_mount), DENY(__NR_fsopen),
        DENY(__NR_fsmount), DENY(__NR_fsconfig), DENY(__NR_fspick),
        DENY(__NR_unshare), DENY(__NR_setns), DENY(__NR_ptrace),
        DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev), DENY(__NR_pidfd_getfd),
        DENY(__NR_bpf), DENY(__NR_perf_event_open), DENY(__NR_open_by_handle_at),
        DENY(__NR_keyctl), DENY(__NR_add_key), DENY(__NR_request_key),
        DENY(__NR_io_uring_setup), DENY(__NR_userfaultfd), DENY(__NR_reboot),
        DENY(__NR_kexec_load), DENY(__NR_kexec_file_load), DENY(__NR_init_module),
        DENY(__NR_finit_module), DENY(__NR_delete_module), DENY(__NR_swapon), DENY(__NR_swapoff),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET |
            CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0xf),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_RAW, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
static void startup_handshake(void) {
    struct stat net;
    if (stat("/proc/self/ns/net", &net)) fail();
    char event[256];
    int length = snprintf(event, sizeof(event), "{\"profile\":\"linux-controller-namespaces-v1\",\"netDev\":\"%llu\",\"netIno\":\"%llu\"}\n",
        (unsigned long long)net.st_dev, (unsigned long long)net.st_ino);
    if (length < 0 || length >= (int)sizeof(event)) fail();
    write_all(3, event, (size_t)length);
    struct pollfd fd = { .fd = 3, .events = POLLIN };
    int ready;
    do { ready = poll(&fd, 1, 5000); } while (ready < 0 && errno == EINTR);
    char ack[2];
    if (ready != 1 || read(3, ack, sizeof(ack)) != 2 || ack[0] != 'O' || ack[1] != 'K') fail();
}
static void wait_for_child(pid_t child) {
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail();
    if (WIFEXITED(status)) _exit(WEXITSTATUS(status));
    _exit(128 + (WIFSIGNALED(status) ? WTERMSIG(status) : SIGKILL));
}
static void parent_liveness(int fd, int child) {
    /* PID1's parent is outside its PID namespace (getppid() is zero). A
     * two-way acknowledgement after PDEATHSIG avoids that namespace race. */
    char byte = child ? 'R' : 'A';
    struct pollfd channel = { .fd = fd, .events = POLLIN };
    if (child) write_all(fd, &byte, 1);
    int ready;
    do { ready = poll(&channel, 1, 5000); } while (ready < 0 && errno == EINTR);
    if (ready != 1 || read(fd, &byte, 1) != 1 || byte != (child ? 'A' : 'R')) fail();
    if (!child) { byte = 'A'; write_all(fd, &byte, 1); }
    if (close(fd)) fail();
}
int main(int argc, char **argv) {
    /* helper <empty-root> <app> <ai> <state> <scratch> <broker-socket> <state-socket> -- <inside-command> [args...] */
    phase = 1;
    if (argc < 10 || strcmp(argv[8], "--") || getuid() == 0 || geteuid() == 0 ||
        getuid() != geteuid() || getgid() != getegid() || fcntl(3, F_GETFD) < 0) fail();
    uid_t uid = getuid(); gid_t gid = getgid(); pid_t parent = getppid();
    int socket_type = 0; socklen_t size = sizeof(socket_type);
    struct ucred credentials; socklen_t credentials_size = sizeof(credentials);
    struct sockaddr_storage socket_address; socklen_t address_size = sizeof(socket_address);
    if (getsockopt(3, SOL_SOCKET, SO_TYPE, &socket_type, &size) || socket_type != SOCK_STREAM ||
        getsockname(3, (struct sockaddr *)&socket_address, &address_size) || socket_address.ss_family != AF_UNIX ||
        getsockopt(3, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_size) ||
        credentials_size != sizeof(credentials) || credentials.pid != parent || credentials.uid != uid ||
        syscall(SYS_close_range, 4, ~0U, 0)) fail();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) fail();
    int root_fd = anchor(argv[1], S_IFDIR), app_fd = anchor(argv[2], S_IFDIR), ai_fd = anchor(argv[3], S_IFDIR),
        state_fd = anchor(argv[4], S_IFDIR), scratch_fd = anchor(argv[5], S_IFDIR), broker_fd = anchor(argv[6], S_IFSOCK),
        state_socket_fd = anchor(argv[7], S_IFSOCK);
    struct stat root_info, state_info, scratch_info, app_info, ai_info;
    if (fstat(root_fd, &root_info) || fstat(state_fd, &state_info) || fstat(scratch_fd, &scratch_info) ||
        fstat(app_fd, &app_info) || fstat(ai_fd, &ai_info) ||
        root_info.st_uid != uid || state_info.st_uid != uid || scratch_info.st_uid != uid ||
        (app_info.st_uid != uid && app_info.st_uid != 0) || ai_info.st_uid != uid ||
        (app_info.st_mode & 022) || (ai_info.st_mode & 022) ||
        (root_info.st_mode & 077) || (state_info.st_mode & 077) || (scratch_info.st_mode & 077)) fail();
    /* Root must be genuinely empty, including dotfiles. */
    int scan = openat(root_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (scan < 0) fail();
    char entries[4096]; long bytes = syscall(SYS_getdents64, scan, entries, sizeof(entries));
    if (bytes < 0) fail();
    for (long offset = 0; offset < bytes;) {
        struct { uint64_t ino; int64_t off; unsigned short length; unsigned char type; char name[]; } *entry = (void *)(entries + offset);
        if (!entry->length || offset + entry->length > bytes || (strcmp(entry->name, ".") && strcmp(entry->name, ".."))) fail();
        offset += entry->length;
    }
    if (syscall(SYS_getdents64, scan, entries, sizeof(entries)) != 0 || close(scan)) fail();
    phase = 2;
    if (unshare(CLONE_NEWUSER)) fail();
    char mapping[128];
    if (snprintf(mapping, sizeof(mapping), "%u %u 1\n", uid, uid) >= (int)sizeof(mapping)) fail();
    write_map("/proc/self/uid_map", mapping);
    write_map("/proc/self/setgroups", "deny");
    if (snprintf(mapping, sizeof(mapping), "%u %u 1\n", gid, gid) >= (int)sizeof(mapping)) fail();
    write_map("/proc/self/gid_map", mapping);
    if (getuid() != uid || getgid() != gid || unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID)) fail();
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fail();
    if (sethostname("excess-worker", 13)) fail();
    /* Mount-tree operations require descriptors in this new mount namespace.
     * Reopen only after matching the pre-namespace device/inode identities. */
    root_fd = refresh_anchor(root_fd, argv[1], S_IFDIR);
    app_fd = refresh_anchor(app_fd, argv[2], S_IFDIR);
    ai_fd = refresh_anchor(ai_fd, argv[3], S_IFDIR);
    state_fd = refresh_anchor(state_fd, argv[4], S_IFDIR);
    scratch_fd = refresh_anchor(scratch_fd, argv[5], S_IFDIR);
    broker_fd = refresh_anchor(broker_fd, argv[6], S_IFSOCK);
    state_socket_fd = refresh_anchor(state_socket_fd, argv[7], S_IFSOCK);
    loopback();
    phase = 30;
    char tmpfs_options[128];
    if (snprintf(tmpfs_options, sizeof(tmpfs_options), "size=16m,mode=0700,uid=%u,gid=%u", uid, gid) >= (int)sizeof(tmpfs_options) ||
        mount("tmpfs", argv[1], "tmpfs", MS_NOSUID | MS_NODEV, tmpfs_options)) fail();
    /* The anchor points at the covered host directory. Address the new mount
     * through the original validated absolute pathname until chroot. */
    const char *mount_root = argv[1];
    char target[PATH_MAX];
    uint64_t ro = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV;
    phase = 31; make_dir(mount_root, "/app", target); bind_fd(app_fd, target, 1, ro);
    phase = 32; make_dir(mount_root, "/ai", target);
    /* No download cache, caller home files or arbitrary store siblings enter
     * the controller view. Only installed model/runtime subtrees are visible. */
    bind_store(ai_fd, mount_root, "models", 0, ro);
    bind_store(ai_fd, mount_root, "runtimes", 0, ro);
    bind_store(ai_fd, mount_root, "sd-runtimes", 1, ro);
    phase = 33; make_dir(mount_root, "/state", target); bind_fd(state_fd, target, 1, ro | MOUNT_ATTR_NOEXEC);
    phase = 34; make_dir(mount_root, "/scratch", target);
    if (snprintf(tmpfs_options, sizeof(tmpfs_options), "size=256m,mode=0700,uid=%u,gid=%u", uid, gid) >= (int)sizeof(tmpfs_options) ||
        mount("tmpfs", target, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, tmpfs_options)) fail();
    phase = 35;
    make_dir(mount_root, "/broker", target);
    if (snprintf(target, PATH_MAX, "%s/broker/socket", mount_root) >= PATH_MAX) fail();
    bind_fd(broker_fd, target, 0, ro | MOUNT_ATTR_NOEXEC);
    make_dir(mount_root, "/state-broker", target);
    if (snprintf(target, PATH_MAX, "%s/state-broker/socket", mount_root) >= PATH_MAX) fail();
    bind_fd(state_socket_fd, target, 0, ro | MOUNT_ATTR_NOEXEC);
    phase = 36; make_dir(mount_root, "/usr", target);
    bind_system(mount_root, "/usr/lib", "/usr/lib", 1, ro);
    bind_system(mount_root, "/lib", "/lib", 1, ro);
    bind_system(mount_root, "/lib64", "/lib64", 1, ro);
    phase = 37; make_dir(mount_root, "/etc", target);
    bind_system(mount_root, "/etc/ld.so.cache", "/etc/ld.so.cache", 0, ro | MOUNT_ATTR_NOEXEC);
    phase = 38; make_dir(mount_root, "/sys", target); make_dir(mount_root, "/sys/devices", target); make_dir(mount_root, "/sys/devices/system", target);
    bind_system(mount_root, "/sys/devices/system/cpu", "/sys/devices/system/cpu", 1, ro | MOUNT_ATTR_NOEXEC);
    phase = 39; make_dir(mount_root, "/dev", target);
    /* Only these host devices are visible; no GPU or terminal devices. */
    const char *devices[] = { "/dev/null", "/dev/urandom" };
    for (size_t n = 0; n < sizeof(devices) / sizeof(devices[0]); n++) {
        int device = anchor(devices[n], S_IFCHR);
        if (snprintf(target, PATH_MAX, "%s%s", mount_root, devices[n]) >= PATH_MAX) fail();
        bind_fd(device, target, 0, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NOEXEC | (n ? MOUNT_ATTR_RDONLY : 0)); close(device);
    }
    make_dir(mount_root, "/proc", target);
    attributes(mount_root, 0, ro | MOUNT_ATTR_NOEXEC);
    phase = 4;
    int alive[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, alive)) fail();
    pid_t child = fork();
    if (child < 0) fail();
    if (child > 0) {
        supervised_child = (sig_atomic_t)child;
        struct sigaction action; memset(&action, 0, sizeof(action));
        action.sa_handler = forward_signal;
        if (sigemptyset(&action.sa_mask) || sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) fail();
        close(alive[1]); parent_liveness(alive[0], 0);
        if (syscall(SYS_close_range, 3, ~0U, 0)) fail();
        drop_capabilities(); restrict_syscalls();
        wait_for_child(child);
    }
    close(alive[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL)) fail();
    parent_liveness(alive[1], 1);
    /* PID1 owns only the private process tree. procfs is mounted after fork. */
    if (mount("proc", target, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=2") || chdir(mount_root) || chroot(".") || chdir("/state")) fail();
    if (syscall(SYS_close_range, 4, ~0U, 0)) fail();
    startup_handshake();
    phase = 5;
    int null = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null < 0 || dup2(null, STDIN_FILENO) < 0 || syscall(SYS_close_range, 3, ~0U, 0)) fail();
    struct rlimit core = { 0, 0 }, files = { 512, 512 };
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &files) ||
        prctl(PR_SET_DUMPABLE, 0) || clearenv() || setenv("HOME", "/state", 1) ||
        setenv("TMPDIR", "/scratch", 1) || setenv("EXCESS_WORKER_HOME", "/state", 1) ||
        setenv("EXCESS_MODEL_DIR", "/ai", 1) || setenv("EXCESS_EGRESS_SOCKET", "/broker/socket", 1) ||
        setenv("PATH", "/app/node/bin", 1)) fail();
    drop_capabilities(); restrict_syscalls();
    phase = 6;
    execv(argv[9], &argv[9]); fail();
}
