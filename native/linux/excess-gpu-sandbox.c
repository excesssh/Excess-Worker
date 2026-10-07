#define _GNU_SOURCE
#define EXCESS_GPU_PROFILE 1
#define main excess_runtime_main
#include "excess-sandbox.c"
#undef main
#include <dlfcn.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/vfs.h>
#include <sys/sysmacros.h>
#include <time.h>

/* Fixed single-device NVIDIA inference profile. The driver remains a shared
 * kernel boundary; this is a sampled conservative device-wide budget, never
 * a hard VRAM reservation or hardware fault partition. No buyer code runs. */
typedef struct { unsigned long long total, free, used; } gpu_memory;
typedef void *gpu_device;
static int (*gpu_info)(gpu_device, gpu_memory *);
static int (*gpu_shutdown)(void);
static gpu_device device;
static volatile sig_atomic_t stopped;
static pid_t supervisor_pid;
static int child_created;
void excess_gpu_preflight_failure(void) {
    if (getpid() == supervisor_pid && !child_created) {
        /* No inference child or temporary model handle exists on this path. */
        puts("{\"type\":\"status\",\"error\":\"GPU_ISOLATION_UNAVAILABLE\"}");
        puts("{\"type\":\"cleanup\",\"ok\":true}"); fflush(stdout);
    }
}
static void stop_signal(int value) { (void)value; stopped = 1; }
static uint64_t monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) fail();
    return (uint64_t)now.tv_sec*1000 + (uint64_t)now.tv_nsec/1000000;
}
static uint64_t rss(pid_t child) {
    char path[64], line[256]; uint64_t value = 0;
    if (snprintf(path, sizeof(path), "/proc/%d/status", child) >= (int)sizeof(path)) fail();
    FILE *file = fopen(path, "r"); if (!file) return UINT64_MAX;
    while (fgets(line, sizeof(line), file)) {
        unsigned long long kib;
        if (sscanf(line, "VmRSS: %llu kB", &kib) == 1) value = kib*1024;
    }
    fclose(file); return value;
}
static int memory(gpu_memory *value) {
    return gpu_info(device, value) == 0 && value->total > 0 && value->used <= value->total && value->free <= value->total;
}
static void init_gpu(void) {
    void *library = dlopen("/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!library) fail();
    int (*init)(void) = dlsym(library, "nvmlInit_v2");
    int (*count)(unsigned int *) = dlsym(library, "nvmlDeviceGetCount_v2");
    int (*get)(unsigned int, gpu_device *) = dlsym(library, "nvmlDeviceGetHandleByIndex_v2");
    gpu_info = dlsym(library, "nvmlDeviceGetMemoryInfo");
    gpu_shutdown = dlsym(library, "nvmlShutdown");
    unsigned int devices = 0;
    if (!init || !count || !get || !gpu_info || !gpu_shutdown || init() || count(&devices) || devices != 1 || get(0, &device)) fail();
    const char *paths[] = { "/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm" };
    for (size_t n = 0; n < sizeof(paths)/sizeof(paths[0]); n++) {
        struct stat info;
        if (lstat(paths[n], &info) || !S_ISCHR(info.st_mode)) fail();
        if ((n == 0 && (major(info.st_rdev) != 195 || minor(info.st_rdev) != 0)) ||
            (n == 1 && (major(info.st_rdev) != 195 || minor(info.st_rdev) != 255)) ||
            (n == 2 && (major(info.st_rdev) == 0 || major(info.st_rdev) == 195 || minor(info.st_rdev) != 0))) fail();
    }
}
static void require_cgroup(uint64_t ram_limit) {
    /* A kernel cgroup mount supplied read-only by the controller, not a file
       which an untrusted process can fabricate in its writable scratch. */
    const char *names[] = { "memory.max", "memory.swap.max", "pids.max", "cpu.max" };
    uint64_t values[4] = { 0 }; uint64_t cpu_period = 0;
    for (size_t n = 0; n < 4; n++) {
        char path[64], text[128]; struct statfs filesystem;
        snprintf(path, sizeof(path), "/gpu-budget/%s", names[n]);
        int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
        if (fd < 0 || fstatfs(fd, &filesystem) || filesystem.f_type != 0x63677270) fail();
        ssize_t got = read(fd, text, sizeof(text)-1); if (got <= 0 || close(fd)) fail(); text[got] = 0;
        if (n == 3) {
            unsigned long long quota, period;
            if (sscanf(text, "%llu %llu", &quota, &period) != 2) fail();
            values[n] = quota; cpu_period = period;
        } else { text[strcspn(text, "\n")] = 0; values[n] = number(text); }
    }
    if (values[0] < ram_limit || values[0] > 128ULL*1024*1024*1024 || values[1] != 0 ||
        values[2] < 1 || values[2] > 128 || !cpu_period || values[3] < 1 || values[3]/cpu_period > 2 || values[3] > 2*cpu_period) fail();
}
int main(int argc, char **argv) {
    supervisor_pid = getpid();
    phase = 40;
    if (argc == 2 && !strcmp(argv[1], "--check")) {
        if (syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < 6) fail();
        puts("linux-cuda-device-budget-v1"); return 0;
    }
    /* helper <GPU bytes> followed by the unchanged CPU helper argument shape. */
    if (argc < 10 || getuid() == 0 || geteuid() == 0) fail();
    uint64_t gpu_limit = number(argv[1]), ram_limit = number(argv[2]), seconds = number(argv[3]);
    if (gpu_limit < 1024ULL*1024*1024 || gpu_limit > 128ULL*1024*1024*1024 ||
        ram_limit < 1024ULL*1024*1024 || ram_limit > 128ULL*1024*1024*1024 || seconds < 1 || seconds > 605) fail();
    struct rlimit core = { 0, 0 };
    if (setrlimit(RLIMIT_CORE, &core) || prctl(PR_SET_DUMPABLE, 0)) fail();
    require_cgroup(ram_limit);
    init_gpu(); gpu_memory baseline;
    if (!memory(&baseline) || gpu_limit > baseline.total || baseline.used > gpu_limit) fail();
    int diagnostics[2]; if (pipe2(diagnostics, O_CLOEXEC) || fcntl(diagnostics[0], F_SETFL, O_NONBLOCK)) fail();
    pid_t parent = getpid(), child = fork(); if (child < 0) fail();
    if (!child) {
        close(diagnostics[0]);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || dup2(diagnostics[1], 2) < 0) fail();
        close(diagnostics[1]);
        int null = open("/dev/null", O_RDWR | O_CLOEXEC);
        if (null < 0 || dup2(null, 0) < 0 || dup2(null, 1) < 0) fail(); close(null);
        return excess_runtime_main(argc-1, argv+1);
    }
    child_created = 1;
    close(diagnostics[1]); signal(SIGTERM, stop_signal); signal(SIGINT, stop_signal);
    if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() == 1) stopped = 1;
    printf("{\"type\":\"started\",\"pid\":%d}\n", child); fflush(stdout);
    uint64_t started = monotonic_ms(), peak = 0;
    unsigned int layers = 0, total_layers = 0; const char *fault = NULL;
    char line[4096]; size_t retained = 0; int discarded = 0, status = 0, reaped = 0;
    while (!stopped && !fault) {
        pid_t waited = waitpid(child, &status, WNOHANG);
        if (waited == child) { reaped = 1; fault = "RUNTIME_EXITED"; break; }
        if (waited < 0) { fault = "RUNTIME_CLEANUP_FAILED"; break; }
        gpu_memory current; uint64_t resident = rss(child);
        if (!memory(&current) || resident == UINT64_MAX) { fault = "GPU_MONITOR_FAILED"; break; }
        if (resident > peak) peak = resident;
        if (resident > ram_limit) { fault = "RUNTIME_MEMORY_LIMIT"; break; }
        if (current.used > gpu_limit) { fault = "GPU_MEMORY_BUDGET_EXCEEDED"; break; }
        if (monotonic_ms()-started > seconds*1000) { fault = "RUNTIME_TIMEOUT"; break; }
        uint64_t local = current.used > baseline.used ? current.used-baseline.used : 0;
        printf("{\"type\":\"status\",\"peakWorkingSetBytes\":%llu,\"gpuMemoryBytes\":%llu,\"gpuLocalBytes\":%llu,\"gpuNonLocalBytes\":%llu,\"gpuOffloadedLayers\":%u,\"gpuTotalLayers\":%u}\n",
            (unsigned long long)peak, current.used, (unsigned long long)local,
            current.used-local, layers, total_layers ? total_layers : 1); fflush(stdout);
        struct pollfd fds[] = { { .fd = diagnostics[0], .events = POLLIN }, { .fd = 0, .events = POLLIN | POLLHUP } };
        int ready = poll(fds, 2, 250); if (ready < 0 && errno != EINTR) { fault = "GPU_MONITOR_FAILED"; break; }
        if (fds[1].revents & POLLHUP) stopped = 1;
        if (fds[1].revents & POLLIN) {
            char control[256]; ssize_t got = read(0, control, sizeof(control)-1);
            if (got <= 0) stopped = 1;
            else { control[got] = 0; if (strstr(control, "\"stop\"")) stopped = 1; }
        }
        if (fds[0].revents & POLLIN) {
            char data[4096]; ssize_t got = read(diagnostics[0], data, sizeof(data));
            for (ssize_t n = 0; n < got; n++) {
                if (data[n] == '\n') {
                    line[retained] = 0; char *marker = discarded ? NULL : strstr(line, "offloaded "); unsigned int offloaded, all;
                    if (marker && sscanf(marker, "offloaded %u/%u layers to GPU", &offloaded, &all) == 2 && all > 0 && all <= 128 && offloaded == all)
                        { layers = offloaded; total_layers = all; }
                    retained = 0; discarded = 0;
                } else if (!discarded && retained < sizeof(line)-1) line[retained++] = data[n];
                else { retained = 0; discarded = 1; }
            }
        }
    }
    if (fault) { printf("{\"type\":\"status\",\"error\":\"%s\"}\n", fault); fflush(stdout); }
    if (!reaped) {
        if (kill(child, SIGKILL) && errno != ESRCH) fail();
        while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail();
    }
    close(diagnostics[0]);
    int cleaned = 0;
    for (int n = 0; n < 12; n++) {
        gpu_memory final;
        if (memory(&final) && final.used <= baseline.used + 16ULL*1024*1024) { cleaned = 1; break; }
        struct timespec pause = { .tv_nsec = 250000000 }; nanosleep(&pause, NULL);
    }
    if (gpu_shutdown()) cleaned = 0;
    printf("{\"type\":\"cleanup\",\"ok\":%s}\n", cleaned ? "true" : "false"); fflush(stdout);
    return cleaned ? (fault ? 1 : 0) : 126;
}
