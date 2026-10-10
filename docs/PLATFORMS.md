# Supported configurations

The first table records the [published Excess Worker 0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) as historical evidence. It does not describe sequence 26. Candidate25 Windows and Linux CPU buyer evidence, plus the separately scoped sequence-26 Linux WSL CPU routes, are listed below. The signed sequence-26 manifest and two-build equality report identify the prepared packages. Fresh direct installation passed on both platforms. Packages are Windows x64 and Linux x64; claims stay scoped to measured configurations. Older reports under `docs/verification/` do not override current evidence.

The Windows CPU/CUDA release gates passed on the recorded machine and package; this release can ship independently of Linux GPU capacity. Linux direct installation and update/recovery also passed. Keep Linux CUDA candidate-unverified until actual Linux NVIDIA buyer execution passes.

| Configuration | Measured setup | Verified result and limits |
| --- | --- | --- |
| Windows x64 CPU | Windows 11 Pro 10.0.22631; pinned Qwen3-4B; two threads; 4 GiB Job Object limit. | Fresh application install, pairing, actual funded testnet buyer job, correct 27-token answer, device signature/accounting, drain, restart, live cancellation, revoke and cleanup. Other Windows configurations remain unverified. |
| Windows x64 NVIDIA CUDA | Same workstation; RTX 3070 Ti 8 GiB, driver 596.49 WDDM; pinned Qwen3-4B/llama.cpp b10809; two threads; separate 6 GiB host and 6 GiB combined GPU budgets. | Same actual buyer journey and cancellation/cleanup. 37/37 layers offloaded; observed peak 4,184 MiB combined and 3,780 MiB dedicated GPU usage. Other models, GPUs/drivers and hardware partitioning are unverified. |
| Linux x64 CPU on WSL2 | Linux 6.18.40.1; pinned Qwen3-4B; two threads; dedicated 8 GiB cgroup v2 user service, zero swap, 64 tasks and CPU 200%. | Fresh application install, funded 27-token buyer answer, device signature/accounting, drain, restart, revoke and cleanup. This is not a fresh OS or general Linux distribution compatibility claim. |
| Linux/WSL GPU | 0.1.0 does not provide a verified GPU route. | The 0.1.0 worker refused Linux GPU execution. For 0.2.0, Linux CUDA remains candidate-unverified pending actual Linux GPU buyer execution; no support claim is made. |

[Exact published-package evidence](verification/published-source77.json) · [installation](INSTALLATION.md) · [release verification](VERIFICATION.md). Fresh default installation, signed HTTPS updates, tamper/downgrade refusal and actual previous-package recovery passed on Windows and Linux. These reports use real project-funded testnet work on the recorded workstation, not independent suppliers or organic demand.

## Candidate25 Windows evidence

Candidate25 source `f07ffd9c6c447ed8f60fd258807a0f7d487796b4`, sequence 25, and Windows archive SHA-256 `34d3febd9c64a1fe968101cfa6932d8a6dd33e50cbdffd7dcf1090195536ebd6` passed eight actual packaged-worker buyer routes on the recorded Windows 11 x64 / RTX 3070 Ti 8 GiB / driver 596.49 workstation. The candidate-only report ended at 17:34:12 UTC with all route success, cancellation, drain and shared cleanup gates passed (report SHA-256 `c7efe17c97de538a6fa0df9c62f39c08f6a2e4671a11a59c479971d98ec4c84a`). Five additional serial SD-Turbo CUDA buyer jobs on that exact candidate returned signed artifacts and accounting; their post-run API audit records all five as `succeeded`. The buffered-media reconciliation preserves the earlier observer gap and records `deliveryStarted=false` as a stream-specific flag (SHA-256 `25b5b3d1c5e320b7d59ab33cda9a330117ddb4c1c14d975ed1f795e38b95f6c3`). The sequence-26 build report matches executable, native, dependency, launcher and licence payload fingerprints against prepared sequence-25 execution evidence for both platforms (SHA-256 `24ff8dbcbfbd6b2454c68b87c3facc615af3a98d70bd089487efbfb7cf743ff4`). Linux direct installation passed. Fresh direct Windows installation passed with 340 files fully hashed, actual Minisign verification, high-water 26 and the expected ready launcher (report SHA-256 `90332df782245a29ab8f7bd66fb9ba49cfefbd2be6fe99033effd993c9926559`).

| Candidate25 model/task | CPU buyer job | CUDA buyer job |
| --- | --- | --- |
| Qwen3-4B / text | Passed | Passed |
| Qwen3 Embedding 0.6B / embeddings | Passed | Passed |
| Qwen3 ASR 0.6B / transcription | Passed | Passed |
| SD-Turbo / images | Passed | Passed; five additional serial CUDA successes also passed buffered-media reconciliation |

The eight candidate25 routes do not establish other models, machines, drivers or Linux support. Twelve other text entries have no Windows buyer-job evidence. FLUX.1 schnell is GPU-only; its 12 GiB estimate exceeds the recorded 8 GiB GPU and it has no buyer execution evidence. See [candidate coverage](windows-media-candidate-coverage.md) and the retained candidate25 route report (SHA-256 `c7efe17c97de538a6fa0df9c62f39c08f6a2e4671a11a59c479971d98ec4c84a`). The signed 0.1.0 packages and evidence above remain unchanged.

## Linux WSL2 CPU candidate evidence

A Qwen3-4B CPU buyer job passed on the signed sequence25 Linux package (source `f07ffd9c6c447ed8f60fd258807a0f7d487796b4`, manifest SHA-256 `d8d516c72e06126957c8f5f05fe0c99ba7b40fc18bb874373ee9b8d8d8fd0493`). The recorded environment was WSL2 Linux 6.18.40.1, regular UID 1000, two CPU threads, an 8 GiB cgroup v2 memory limit, zero swap, 64 tasks and CPU 200% (buyer report SHA-256 `69ad5c07769137a361122a3fd461f1c29adfbc09c2980da02c89152ffc4843ef`). The sequence 26 build report matched executable, native, dependency, launcher and licence payload fingerprints against the prepared sequence25 execution evidence. A fresh direct signed sequence 26 Linux install passed with 343 fully hashed files, executable modes checked, high-water 26 and zero owned runtime processes (report SHA-256 `74fdfd8eda85e4e6a39e59b25961aa12bb984efd385b8274d6d5cf3025da218b`). A separate signed sequence 26 update/recovery report passed a Qwen3-4B CPU probe. These results establish only the recorded WSL2 CPU route and Linux install/update checks; they do not establish other Linux distributions or GPU execution.

## Published sequence-26 Linux WSL CPU evidence

Three CPU buyer routes passed on the signed published Excess Worker 0.2.0 package: Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and Qwen3-8B. They ran on Linux x64 under WSL in the recorded environments, with two worker threads, an 8 GiB memory maximum and zero swap. The evidence is limited to those WSL CPU routes.

| Model | Backend and task | Recorded result |
| --- | --- | --- |
| Qwen3 Embedding 0.6B | CPU embeddings | Passed with a meaningful result, verified output proof and separately reconciled buyer accounting. |
| Qwen3 ASR 0.6B | CPU transcription | Passed with a meaningful result, verified output proof and separately reconciled buyer accounting. |
| Qwen3-8B | CPU inference | Full-success route returned a meaningful 128-token response with output-signature and proof verification recorded; a separate prefix-cancel route acknowledged 8 tokens and ended with accounted cancellation, without a final-result signature. See the [Qwen3-8B route record](verification/qwen3-8b-linux-wsl-cpu.md). |

The embedding and ASR route record reports drain-before-stop, process closure, empty service cgroup, post-restart limits, revocation, local unpair and scratch cleanup. The Qwen3-8B observer record also marks both full lifecycles and cleanup as passed. Its accounting is reported separately from the output signature; the observer records actual API/SDK checks and buyer and supplier wallet readbacks. The [sanitized observer-record JSON](verification/qwen3-8b-linux-wsl-cpu.json) preserves flags and digests, but it is not independent public receipt validation.

This evidence is limited to the named models on Linux x64 under WSL. It does not establish bare-metal Linux or general distribution support, other catalogue routes, Linux GPU execution, hardware identity or honest inference. The output and report hashes are reference pins, not independent receipt-signature or hardware proof. See the [embedding and ASR evidence record](verification/linux-cpu-sequence26.md) and the [Qwen3-8B evidence record](verification/qwen3-8b-linux-wsl-cpu.md).

## Sequence-26 Windows update and CPU recovery evidence

The signed default-fetch HTTPS updater passed 11 checks upgrading a signed sequence18 installation to sequence 26. Bad signature, manifest and archive inputs were refused without changing state; TLS validation and process-only extra-CA handling were enabled; downgrade was refused; rollback and roll-forward kept the sequence 26 update floor. The final inventory verified both installed packages, with 339 and 340 files fully hashed and high-water 26 (report SHA-256 `2793d6a3b5a62b86b42c4909d83d09d0ba7c69a30b0dacee5ef10444c1eb42e1`). A fresh direct sequence 26 install passed with all 340 files hashed, high-water 26 and the expected ready launcher (report SHA-256 `90332df782245a29ab8f7bd66fb9ba49cfefbd2be6fe99033effd993c9926559`). Separate isolated CPU and CUDA recovery probes passed on sequence18 and sequence 26; the CUDA Qwen3-4B Q4_K_M probe offloaded 37 layers and preserved the sequence 26 high-water mark (CPU report SHA-256 `4ec5fb249d8cb7ac0de44a5c4a42e7484e085b11b3c2a4f6c0a81ecf1caab62c`; CUDA report SHA-256 `26c9c7b109e295759260cef8b511114fa367b292767f89a1c0ad1ff17190b7b7`). These are runtime recovery probes, not buyer jobs.

## Linux requirements

The successor contains a **development Linux CUDA candidate profile**. It remains candidate-unverified and is not a GPU support claim; the 0.1.0 table above remains specific to that release. The candidate restricts one NVIDIA device and selected control calls for fixed trusted inference, keeps the sealed controller and model filesystem/network/credential/process boundaries, enforces hard cgroup CPU/RAM/task limits, and samples whole-device memory through NVML every 250 ms. Cancellation, deadlines and cleanup are required; missing monitoring or limits refuse execution. Shared-driver access and sampling provide no hard VRAM reservation or hardware fault partition. WSL `/dev/dxg` is outside this profile. Runtime pin reproducibility establishes build inputs only. No Linux CUDA model run or buyer job has been verified, and all 17 local entries remain untested on this route; describe it as candidate-unverified and make no GPU support claim. See the [per-model coverage record](linux-cuda-catalogue-coverage.md). A signed candidate25 WSL2 CPU buyer job passed; the signed sequence 26 Linux install and update/recovery checks passed. The separate Windows direct-install report passed a complete 340-file inventory, launcher check and high-water-26 validation; no Linux NVIDIA job is implied by this evidence.

Run as an ordinary non-root x64 user with systemd and a usable user service session. The boundary requires user and network namespaces, Landlock ABI 6 or newer, seccomp and cgroup v2. The dedicated `excess-worker.service` must have finite memory, zero swap, task-count and CPU limits. Missing kernel features, helper hashes, namespace identity or cgroup bounds refuse execution. [Service commands](INSTALLATION.md#supply-capacity) · [native build requirements](BUILD.md#linux-native-helpers).

The published 0.1.0 service generator caps memory at 75% of detected RAM, at most 12 GiB, with zero swap, 128 tasks and CPU 200%. The recorded release test used an explicit 8 GiB/64-task override. In source 0.2.0, a Linux CUDA policy may explicitly request up to 126 GiB host RAM plus 2 GiB controller overhead and up to 128 GiB GPU memory; the service still caps host memory at 75% of detected RAM and refuses inadequate budgets. Linux model runtimes may need system shared libraries; `doctor` names missing prerequisites. Inventory and catalog fit estimates do not prove execution.

## Supplier-machine boundary

Buyers submit bounded inference inputs: text prompts, embedding text, attributed audio or image prompts, with task-specific limits. They do not submit executable code, kernels, models or runtime arguments. Suppliers choose trusted, hash-pinned runtimes and licensed models.

The published 0.1.0 Windows paired worker admits text only. Candidate25 adds typed Windows embedding, transcription and image routes with bounded audio/artifact transfer, assignment-bound execution proofs and validated task billing. All eight CPU/CUDA routes for Qwen3-4B, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and SD-Turbo passed on the recorded machine, with route cancellation and shared cleanup. Five separate serial SD-Turbo CUDA jobs also returned signed artifacts and accounting with succeeded authoritative API states. Their `deliveryStarted=false` flags are stream-specific and do not establish non-delivery of buffered images. The earlier failed job's cause remains unestablished; a separate native fixture found and fixed an admission-ordering regression but does not establish that cause. The signed default-fetch Windows updater passed tamper/downgrade refusal, upgrade, rollback and roll-forward checks; CPU probes passed on sequence18 and sequence 26. Fresh direct Windows installation passed with 340 files fully hashed and the expected launcher; separate CPU and CUDA recovery probes passed on sequences18 and 26. The Linux direct install and update/recovery checks passed. See [Windows media candidate coverage](windows-media-candidate-coverage.md) and the [model catalogue](MODEL-CATALOG.md).

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

## Published sequence 26 Qwen3-8B Windows CPU

Published 0.2.0, source `8724162f793d3ec009eb2f64f713a05c29857bd7`, sequence 26 passed on Windows 11 x64 with two CPU threads, a 10 GiB host cap and a 300-second job limit. The useful 116-token answer and an eight-token acknowledged-prefix cancellation have verified signatures and exact accounting; drain/restart, revocation and process/proof/scratch cleanup pass. This verifies the recorded CPU configuration only; Qwen3-8B CUDA and other platforms remain unverified. See the [bounded execution record](verification/qwen3-8b-windows-cpu.md).

## Published sequence 26 Qwen3-14B Windows CPU

Published 0.2.0 passed on 8 October 2026 on Windows 11 x64 with 32 GiB host memory, two CPU threads, an 11 GiB host cap and a 300-second job limit. The useful 65-word answer billed 80 output tokens; stream order and digests, final worker signature and receipt were verified. An eight-token acknowledged cancellation prefix was signed and accounted, with no final result signature or receipt. Success settled 889 gross units (800 supplier net + 89 fee); cancellation settled 89 gross units (80 net + 9 fee). Drain/restart, revocation, local retirement, awaited process termination, proof retirement and owned scratch cleanup passed. This is operator-funded testnet evidence and establishes no hardware/model attestation, organic demand or mainnet payment. Qwen3-14B CUDA and Linux CPU/NVIDIA remain unverified. See the [bounded execution record](verification/qwen3-14b-windows-cpu.md).
