#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures;

static void result(const char *name, int ok) {
    printf("%s:%s\n", ok ? "PASS" : "FAIL", name);
    if (!ok) failures++;
}

static int expect_errno(int rc, int expected) {
    return rc == -1 && errno == expected;
}

static unsigned long parse_request(const char *value) {
    char *end = NULL;
    errno = 0;
    unsigned long parsed = strtoul(value, &end, 0);
    if (errno || !value[0] || !end || *end) return 0;
    return parsed;
}

static int pdeathsig_probe(void) {
    int ready[2];
    if (pipe(ready)) return 2;
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) {
        close(ready[0]);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1) _exit(3);
        char byte = 'x';
        if (write(ready[1], &byte, 1) != 1) _exit(4);
        close(ready[1]);
        for (;;) pause();
    }
    close(ready[1]);
    char byte;
    if (read(ready[0], &byte, 1) != 1) return 2;
    close(ready[0]);
    printf("PDEATHSIG_CHILD:%ld\n", (long)child);
    fflush(stdout);
    _exit(0);
}

static int run_probe(int argc, char **argv) {
    if (argc != 13) {
        fprintf(stderr, "probe expects file fixtures, ioctl requests, signal target, symlink, and three GPU path fixtures\n");
        return 2;
    }
    const char *allowed = argv[1], *forbidden = argv[2], *scratch = argv[3], *model = argv[5], *escape_link = argv[9];
    unsigned long port = strtoul(argv[4], NULL, 10);
    unsigned long allow_ioctl = parse_request(argv[6]);
    unsigned long deny_ioctl = parse_request(argv[7]);
    pid_t outside_pid = (pid_t)strtol(argv[8], NULL, 10);
    char buffer[32];

    int fd = open(allowed, O_RDONLY | O_CLOEXEC);
    int blocked = 0;
    result("allowed-read", fd >= 0 && read(fd, buffer, sizeof(buffer)) > 0);
    if (fd >= 0) close(fd);

    errno = 0;
    fd = open(escape_link, O_RDONLY | O_CLOEXEC);
    blocked = expect_errno(fd, EACCES);
    result("symlink-escape-denied", blocked);
    if (fd >= 0) close(fd);

    errno = 0;
    fd = open(forbidden, O_RDONLY | O_CLOEXEC);
    blocked = expect_errno(fd, EACCES);
    result("forbidden-read", blocked);
    if (fd >= 0) close(fd);

    errno = 0;
    fd = open(allowed, O_WRONLY | O_CLOEXEC);
    blocked = expect_errno(fd, EACCES);
    result("readonly-input", blocked);
    if (fd >= 0) close(fd);

    fd = open(model, O_RDONLY | O_CLOEXEC);
    result("model-read", fd >= 0 && read(fd, buffer, sizeof(buffer)) > 0);
    if (fd >= 0) close(fd);
    errno = 0;
    fd = open(model, O_WRONLY | O_CLOEXEC);
    blocked = expect_errno(fd, EACCES);
    result("model-write", blocked);
    if (fd >= 0) close(fd);

    char scratch_file[PATH_MAX];
    if (snprintf(scratch_file, sizeof(scratch_file), "%s/output", scratch) >= (int)sizeof(scratch_file)) return 2;
    fd = open(scratch_file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    int wrote = fd >= 0 && write(fd, "ok", 2) == 2;
    result("scratch-write", wrote);
    if (fd >= 0) close(fd);

    fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    result("null-device", fd >= 0);
    if (fd >= 0) close(fd);
    for (int index = 10; index <= 12; index++) {
        fd = open(argv[index], O_RDWR | O_CLOEXEC);
        result("listed-gpu-device-path", fd >= 0);
        if (fd >= 0) close(fd);
    }
    struct stat device_info;
    if (stat("/dev/random", &device_info) == 0) {
        errno = 0;
        fd = open("/dev/random", O_RDONLY | O_CLOEXEC);
        blocked = expect_errno(fd, EACCES);
        result("unlisted-device", blocked);
        if (fd >= 0) close(fd);
    } else {
        puts("SKIP:unlisted-device-node-absent");
    }

    errno = 0;
    int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    result("unix-socket-denied", expect_errno(sock, EPERM));
    if (sock >= 0) close(sock);
    errno = 0;
    sock = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    result("udp-socket-denied", expect_errno(sock, EPERM));
    if (sock >= 0) close(sock);

    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int bound = listener >= 0 && bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0;
    result("allowed-tcp-bind", bound);
    if (bound) listen(listener, 1);
    if (listener >= 0) close(listener);

    address.sin_port = htons((uint16_t)(port + 1));
    errno = 0;
    sock = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int denied_bind = sock >= 0 && expect_errno(bind(sock, (struct sockaddr *)&address, sizeof(address)), EACCES);
    result("unlisted-tcp-bind", denied_bind);
    if (sock >= 0) close(sock);

    address.sin_port = htons((uint16_t)port);
    errno = 0;
    sock = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int denied_connect = sock >= 0 && expect_errno(connect(sock, (struct sockaddr *)&address, sizeof(address)), EACCES);
    result("tcp-connect-denied", denied_connect);
    if (sock >= 0) close(sock);

    errno = 0;
    pid_t child = fork();
    int fork_denied = child == -1 && errno == EPERM;
    result("fork-denied", fork_denied);
    if (child == 0) _exit(0);
    if (child > 0) waitpid(child, NULL, 0);

    errno = 0;
    long traced = ptrace(PTRACE_TRACEME, 0, NULL, NULL);
    result("ptrace-denied", traced == -1 && errno == EPERM);

    struct iovec local = { .iov_base = buffer, .iov_len = 1 };
    struct iovec remote = { .iov_base = buffer, .iov_len = 1 };
    errno = 0;
    long inspected = syscall(SYS_process_vm_readv, getpid(), &local, 1, &remote, 1, 0);
    result("process-vm-read-denied", inspected == -1 && errno == EPERM);

    errno = 0;
    int signal_rc = kill(outside_pid, 0);
    result("cross-domain-signal-denied", signal_rc == -1 && errno == EPERM);

    fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    int allow_result = -2;
    if (fd >= 0 && allow_ioctl) {
        errno = 0;
        allow_result = ioctl(fd, allow_ioctl, 0);
        if (allow_result != -1 || errno != ENOTTY)
            fprintf(stderr, "allowlisted ioctl result=%d errno=%d request=0x%lx\n", allow_result, errno, allow_ioctl);
        result("allowlisted-rm-ioctl-reaches-fd", allow_result == -1 && errno == ENOTTY);
    } else {
        result("allowlisted-rm-ioctl-reaches-fd", 0);
    }
    if (fd >= 0 && deny_ioctl) {
        errno = 0;
        int rc = ioctl(fd, deny_ioctl, 0);
        if (rc != -1 || errno != EPERM)
            fprintf(stderr, "unlisted ioctl result=%d errno=%d request=0x%lx\n", rc, errno, deny_ioctl);
        result("unlisted-rm-ioctl-denied", rc == -1 && errno == EPERM);
    } else {
        result("unlisted-rm-ioctl-denied", 0);
    }
    if (fd >= 0) close(fd);

    fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    int urandom_open = fd >= 0;
    errno = 0;
    int unlisted_ioctl = urandom_open ? ioctl(fd, allow_ioctl, 0) : 0;
    result("unselected-device-ioctl-denied", urandom_open && unlisted_ioctl == -1 && errno == EACCES);
    if (fd >= 0) close(fd);

    fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (fd >= 0) {
        errno = 0;
        int rc = ioctl(fd, 0x100000000UL | allow_ioctl, 0);
        result("ioctl-upper-word-denied", rc == -1 && errno == EPERM);
        close(fd);
    } else {
        result("ioctl-upper-word-denied", 0);
    }

    printf("RESULT:%s\n", failures ? "failed" : "passed");
    return failures ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--pdeathsig")) return pdeathsig_probe();
    return run_probe(argc, argv);
}
