# Platform status

Current evidence as of 7 October 2026. No downloadable worker release is published. Older reports under `docs/verification/` are historical evidence for their own exact sources and fixtures; they do not override this status.

| Configuration | What passed | What remains |
| --- | --- | --- |
| Windows x64 CPU | Exact source70 project-Minisign-signed candidate: fresh application installation, pinned Qwen3-4B CPU inference with a 4 GiB Job Object limit, live HTTPS pairing, funded testnet buyer job, signed receipt/accounting, drain, restart, remote revoke and cleanup. | A public binary release and positive network update. |
| Linux x64 CPU on WSL | Exact source70 signed candidate, pinned Qwen3-4B, dedicated 8 GiB cgroup v2 service, swap 0, 64 tasks and 200% CPU. Fresh application installation and the same funded testnet journey/recovery passed; measured peak was 6,535,430,144 bytes. | A public binary release and positive network update. This workstation/WSL proof is not a fresh OS or general Linux-host compatibility claim. |
| Windows x64 CUDA development | Windows 11 Pro 10.0.22631 x64, RTX 3070 Ti (8 GiB), driver 596.49, WDDM, pinned Qwen3-4B Q4_K_M/llama.cpp b10809, two threads, explicit 6 GiB host commitment and 6 GiB combined GPU usage budgets. 37/37 layers, correct 27-token answer, cancellation, new restart and cleanup passed. | The exact signed-package funded GPU buyer journey, drain/revoke and release verification. Other GPU/model/driver configurations remain unverified. |
| Linux/WSL GPU | WSL CUDA driver discovery succeeds on the same RTX3070Ti. The current Linux CPU sandbox denies `/dev/dxg` (errno13; CUDA init304). | A pinned Linux CUDA runtime and a justified GPU device/ioctl confinement profile. GPU execution remains refused; missing Vulkan does not imply missing CUDA hardware. |
| Native controller/runtime boundaries | Windows AppContainer and Linux namespace/Landlock/cgroup fixtures pass. Windows now retains unrelated/live ACL grants during lease cleanup; original model-runtime transaction serialization remains. | These fixtures do not attest malicious-model honesty, hardware execution or all driver/platform combinations. |
| Installation and recovery | Actual signed offline installers, complete installed-file/mode verification, previous-signed-package manual rollback/probe and roll-forward passed on both platforms. Sequence11 high-water remains unchanged. | Controlled HTTPS signed network update and rollback tests, production feed and public download checks. |

[Signed CPU report](verification/signed-cpu-source70.json) | [Windows CUDA development report](verification/windows-cuda-development.json) | [Signature and installation checks](VERIFICATION.md)

## Supplier-machine boundary

Buyers submit bounded inference inputs: prompt, maxTokens and seed. They do not submit executable code, kernels, model files or runtime arguments. The supplier selects a trusted, hash-pinned runtime and licensed model.

Windows CUDA retains the existing read-only file grants, private scratch, credential/environment filtering, network-denied AppContainer, authenticated relay, process limit, deadline and cleanup. CPU commitment uses a hard Job Object limit. GPU control is separate: a 250 ms watchdog sums WDDM local/dedicated and nonlocal/shared process usage and stops on excess or failed monitoring. GPU scheduling priority is idle. Before inference input is accepted, the host requires 37/37 offloaded layers and sufficient dedicated GPU usage; CPU fallback is refused.

[MIG](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/introduction.html) provides hardware memory/compute/fault partitioning for mutually untrusted tenants. It is not an inherent requirement for this fixed trusted inference workload. This Windows profile relies on the shared trusted OS, GPU and driver. It provides no hard VRAM reservation, dedicated GPU slice, throughput guarantee or hardware fault isolation. [WDDM process GPU virtual address spaces](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-virtual-memory-in-wddm-2-0) provide the OS/driver boundary. CUDA availability alone is not isolation evidence.

For this development configuration, load a policy file containing:

```json
{"model":"qwen3-4b","backend":"cuda","threads":2,"maxMemoryMb":6144,"maxGpuMemoryMb":6144,"runSeconds":180}
```

Apply it with `excess-worker policy policy.json` and use the pinned model route in [MODELS.md](MODELS.md). This is a source-development configuration, not an instruction to install an unpublished binary. The4 GiB default GPU budget was insufficient for the measured workload and correctly refused it. Do not raise limits without supplier consent or advertise an unverified model/backend.

Release signing is anonymous Minisign. Windows executables have no trusted Authenticode publisher signature; paid certificates and identity verification are outside scope. Signed metadata authenticates source/artifact hashes, not honest inference or hardware.
