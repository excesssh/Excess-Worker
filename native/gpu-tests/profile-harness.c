#define _GNU_SOURCE
#define EXCESS_GPU_PROFILE 1
#define main excess_runtime_main
#ifndef EXCESS_GPU_SANDBOX_INCLUDE
#define EXCESS_GPU_SANDBOX_INCLUDE "../linux/excess-sandbox.c"
#endif
#include EXCESS_GPU_SANDBOX_INCLUDE
#undef main

void excess_gpu_preflight_failure(void) { }

int main(int argc, char **argv) {
    return excess_runtime_main(argc, argv);
}
