# Supported configurations

Current evidence for the [published Excess Worker 0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0), as of 7 October 2026. Packages are Windows x64 and Linux x64; execution support is scoped to the measured configurations below. Older reports under `docs/verification/` do not override this status.

| Configuration | Measured setup | Verified result and limits |
| --- | --- | --- |
| Windows x64 CPU | Windows 11 Pro 10.0.22631; pinned Qwen3-4B; two threads; 4 GiB Job Object limit. | Fresh application install, pairing, actual funded testnet buyer job, correct 27-token answer, device signature/accounting, drain, restart, live cancellation, revoke and cleanup. Other Windows configurations remain unverified. |
| Windows x64 NVIDIA CUDA | Same workstation; RTX 3070 Ti 8 GiB, driver 596.49 WDDM; pinned Qwen3-4B/llama.cpp b10809; two threads; separate 6 GiB host and 6 GiB combined GPU budgets. | Same actual buyer journey and cancellation/cleanup. 37/37 layers offloaded; observed peak 4,184 MiB combined and 3,780 MiB dedicated GPU usage. Other models, GPUs/drivers and hardware partitioning are unverified. |
| Linux x64 CPU on WSL2 | Linux 6.18.40.1; pinned Qwen3-4B; two threads; dedicated 8 GiB cgroup v2 user service, zero swap, 64 tasks and CPU 200%. | Fresh application install, funded 27-token buyer answer, device signature/accounting, drain, restart, revoke and cleanup. This is not a fresh OS or general Linux distribution compatibility claim. |
| Linux/WSL GPU | CUDA discovery succeeds on the same GPU; the current CPU sandbox denies `/dev/dxg`. | A pinned Linux CUDA route and justified device/ioctl confinement profile are missing. GPU execution remains unsupported and refused. |

[Exact published-package evidence](verification/published-source77.json) · [installation](INSTALLATION.md) · [release verification](VERIFICATION.md). Fresh default installation, signed HTTPS updates, tamper/downgrade refusal and actual previous-package recovery passed on Windows and Linux. These reports use real project-funded testnet work on the recorded workstation, not independent suppliers or organic demand.

## Unpublished Windows candidate evidence

Sequence 24 from source `7a33c1b51a12fea87601e3d81d5a9b1b114588d6` has the following actual packaged-worker testnet buyer results on Windows 11 x64, RTX 3070 Ti 8 GiB, driver 596.49:

| Model/task | CPU | CUDA |
| --- | --- | --- |
| Qwen3-4B / text | Passed | Passed |
| Qwen3 Embedding 0.6B / embeddings | Passed | Passed |
| Qwen3 ASR 0.6B / transcription | Passed | Passed |
| SD-Turbo / images | Passed | Passed on retry; earlier delivery failure unresolved |

These eight routes do not establish other models, machines, drivers or Linux support. Twelve other text entries and FLUX.1 schnell have no Windows buyer-job evidence at this checkpoint. See [candidate coverage](windows-media-candidate-coverage.md) and [exact candidate evidence](verification/windows-source90.json). The signed 0.1.0 packages above remain unchanged.

## Linux requirements

Source version 0.2.0 adds a **development Linux CUDA profile**, pending actual NVIDIA execution and signed-package gates. It does not change the 0.1.0 configurations above. The candidate restricts one NVIDIA device and selected control calls for fixed trusted inference, keeps the sealed controller and model filesystem/network/credential/process boundaries, enforces hard cgroup CPU/RAM/task limits, and samples whole-device memory through NVML every 250 ms. Cancellation, deadlines and cleanup are required; missing monitoring or limits refuse execution. Shared-driver access and sampling provide no hard VRAM reservation or hardware fault partition. WSL `/dev/dxg` is outside this profile. Runtime pin reproducibility establishes build inputs only. No Linux CUDA model run or buyer job has been verified, and all 17 local entries remain untested on this route; see the [per-model coverage record](linux-cuda-catalogue-coverage.md).

Run as an ordinary non-root x64 user with systemd and a usable user service session. The boundary requires user and network namespaces, Landlock ABI 6 or newer, seccomp and cgroup v2. The dedicated `excess-worker.service` must have finite memory, zero swap, task-count and CPU limits. Missing kernel features, helper hashes, namespace identity or cgroup bounds refuse execution. [Service commands](INSTALLATION.md#supply-capacity) · [native build requirements](BUILD.md#linux-native-helpers).

The published 0.1.0 service generator caps memory at 75% of detected RAM, at most 12 GiB, with zero swap, 128 tasks and CPU 200%. The recorded release test used an explicit 8 GiB/64-task override. In source 0.2.0, a Linux CUDA policy may explicitly request up to 126 GiB host RAM plus 2 GiB controller overhead and up to 128 GiB GPU memory; the service still caps host memory at 75% of detected RAM and refuses inadequate budgets. Linux model runtimes may need system shared libraries; `doctor` names missing prerequisites. Inventory and catalog fit estimates do not prove execution.

## Supplier-machine boundary

Buyers submit bounded inference inputs: text prompts, embedding text, attributed audio or image prompts, with task-specific limits. They do not submit executable code, kernels, models or runtime arguments. Suppliers choose trusted, hash-pinned runtimes and licensed models.

The published 0.1.0 Windows paired worker admits text only. Source 0.2.0 adds typed Windows embedding, transcription and image routes with bounded audio/artifact transfer, assignment-bound execution proofs and validated task billing. Eight candidate24 CPU/CUDA buyer routes now pass on the recorded machine; the first CUDA image delivery failure remains unresolved and successor release gates remain open. See [Windows media candidate coverage](windows-media-candidate-coverage.md) and the [model catalogue](MODEL-CATALOG.md).

Windows CUDA retains read-only file grants, private scratch, credential/environment filtering, network-denied AppContainers, authenticated relay, process limits, deadlines and cleanup. CPU memory commitment uses a hard Job Object limit. GPU control is separate: a 250 ms watchdog sums dedicated and shared WDDM process usage and stops on overshoot or failed monitoring. GPU scheduling priority is idle. Before accepting inference input, llama.cpp routes require full layer-offload evidence and sufficient dedicated residency; image routes require model-weight-based dedicated residency. CPU fallback is refused.

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
