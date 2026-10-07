# Supported configurations

Current evidence for the [published Excess Worker 0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0), as of 7 October 2026. Packages are Windows x64 and Linux x64; execution support is scoped to the measured configurations below. Older reports under `docs/verification/` do not override this status.

| Configuration | Measured setup | Verified result and limits |
| --- | --- | --- |
| Windows x64 CPU | Windows 11 Pro 10.0.22631; pinned Qwen3-4B; two threads; 4 GiB Job Object limit. | Fresh application install, pairing, actual funded testnet buyer job, correct 27-token answer, device signature/accounting, drain, restart, live cancellation, revoke and cleanup. Other Windows configurations remain unverified. |
| Windows x64 NVIDIA CUDA | Same workstation; RTX 3070 Ti 8 GiB, driver 596.49 WDDM; pinned Qwen3-4B/llama.cpp b10809; two threads; separate 6 GiB host and 6 GiB combined GPU budgets. | Same actual buyer journey and cancellation/cleanup. 37/37 layers offloaded; observed peak 4,184 MiB combined and 3,780 MiB dedicated GPU usage. Other models, GPUs/drivers and hardware partitioning are unverified. |
| Linux x64 CPU on WSL2 | Linux 6.18.40.1; pinned Qwen3-4B; two threads; dedicated 8 GiB cgroup v2 user service, zero swap, 64 tasks and CPU 200%. | Fresh application install, funded 27-token buyer answer, device signature/accounting, drain, restart, revoke and cleanup. This is not a fresh OS or general Linux distribution compatibility claim. |
| Linux/WSL GPU | CUDA discovery succeeds on the same GPU; the current CPU sandbox denies `/dev/dxg`. | A pinned Linux CUDA route and justified device/ioctl confinement profile are missing. GPU execution remains unsupported and refused. |

[Exact published-package evidence](verification/published-source77.json) · [installation](INSTALLATION.md) · [release verification](VERIFICATION.md). Fresh default installation, signed HTTPS updates, tamper/downgrade refusal and actual previous-package recovery passed on Windows and Linux. These reports use real project-funded testnet work on the recorded workstation, not independent suppliers or organic demand.

## Linux requirements

Run as an ordinary non-root x64 user with systemd and a usable user service session. The boundary requires user and network namespaces, Landlock ABI 6 or newer, seccomp and cgroup v2. The dedicated `excess-worker.service` must have finite memory, zero swap, task-count and CPU limits. Missing kernel features, helper hashes, namespace identity or cgroup bounds refuse execution. [Service commands](INSTALLATION.md#supply-capacity) · [native build requirements](BUILD.md#linux-native-helpers).

The worker's service generator caps memory at 75% of detected RAM, at most 12 GiB, with zero swap, 128 tasks and CPU 200%. The recorded release test used an explicit 8 GiB/64-task override. Linux model runtimes may need system shared libraries; `doctor` names missing prerequisites. Inventory and catalog fit estimates do not prove execution.

## Supplier-machine boundary

Buyers submit bounded inference inputs: prompt, maximum tokens and seed. They do not submit executable code, kernels, models or runtime arguments. Suppliers choose trusted, hash-pinned runtimes and licensed models.

Windows CUDA retains read-only file grants, private scratch, credential/environment filtering, network-denied AppContainers, authenticated relay, process limits, deadlines and cleanup. CPU memory commitment uses a hard Job Object limit. GPU control is separate: a 250 ms watchdog sums dedicated and shared WDDM process usage and stops on overshoot or failed monitoring. GPU scheduling priority is idle. Before accepting inference input, the host requires full layer-offload evidence and sufficient dedicated residency; CPU fallback is refused.

This profile trusts the shared OS, GPU and driver. It provides no hard VRAM reservation, dedicated slice, throughput guarantee or hardware fault partition. [WDDM process GPU address spaces](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-virtual-memory-in-wddm-2-0) describe the OS/driver boundary. [MIG](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/introduction.html) provides different hardware separation for supported devices; it is not implemented here. CUDA availability alone is not isolation evidence.

## Windows CUDA policy

For the measured CUDA workload, save this policy as `policy.json` and review the budgets before applying it:

```json
{"model":"qwen3-4b","backend":"cuda","threads":2,"maxMemoryMb":6144,"maxGpuMemoryMb":6144,"runSeconds":180}
```

```sh
excess-worker policy policy.json
excess-worker model-plan qwen3-4b --gpu
```

After accepting the displayed model/runtime plan and licences:

```sh
excess-worker install-model qwen3-4b --gpu --accept-download --accept-licenses
```

The 4 GiB default GPU budget correctly refused the measured workload as insufficient. Do not raise limits without supplier consent or advertise an unverified backend/model. See [model pins](MODELS.md) and [controls](OPERATIONS.md).

## Evidence interpretation

Windows AppContainer and Linux namespace/Landlock/cgroup fixtures cover named filesystem, credential, broker, network, process, memory and cleanup cases. Fixtures do not attest inference honesty or every host/driver combination. Actual signed-package jobs supply separate execution evidence. Source identifiers, release sequences and historical fixtures are documented in [technical verification](VERIFICATION.md#technical-release-evidence).

Release signing uses anonymous Minisign. Windows executables have no trusted Authenticode publisher signature. Signed metadata authenticates release contents, not honest inference or hardware identity.
