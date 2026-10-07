# Platform status

Current evidence as of 7 October 2026. No downloadable worker release is published. Older reports under `docs/verification/` are historical evidence for their own exact sources and fixtures; they do not override this status.

| Configuration | Verified configuration and result | Remaining limits |
| --- | --- | --- |
| Windows x64 CPU | Exact source74 signed candidate15; pinned Qwen3-4B, two threads, 4GiB Job Object limit. Fresh application install, pairing, funded27-token buyer job, verified device signature, accounting, running drain, fresh restart, buyer cancellation, revoke and cleanup pass. | Final eligible-package and controlled HTTPS update/recovery checks before public binaries. |
| Windows x64 CUDA | Windows11Pro10.0.22631 x64, RTX3070Ti8192MiB, driver596.49 WDDM; pinned Qwen3-4B/llama.cppb10809, two threads, separate6GiB host and6GiB combined GPU budgets. Exact signed candidate15 completes the same funded buyer journey, live cancellation and cleanup.37/37layers, peak4184MiB combined/3780MiB dedicated. | Other models, GPU/driver combinations and hardware partitioning are unverified. Final release/update checks remain. |
| Linux x64 CPU on WSL | Exact source74 signed candidate15; pinned Qwen3-4B, two threads, dedicated8GiB cgroupv2 user service, swap0,64tasks,CPU200%. Fresh application install, funded27-token signed buyer receipt/accounting, drain, fresh restart and revoke pass. | This workstation/WSL proof is not a fresh OS or general Linux-host compatibility claim. Final release/update checks remain. |
| Linux/WSL GPU | CUDA driver discovery succeeds on the same RTX3070Ti; current CPU sandbox denies /dev/dxg (errno13, CUDA init304). | Pinned Linux CUDA runtime/device/ioctl confinement profile is missing; GPU remains refused. Missing Vulkan does not imply missing CUDA hardware. |
| Native boundaries | Windows AppContainer and Linux namespace/Landlock/cgroup fixtures pass. Filesystem, credentials, broker, network, process, memory and cleanup protections remain. | Fixtures do not attest inference honesty or every platform/driver combination. |
| Installation and recovery | Actual signed offline installation and previous-signed-package manual recovery passed. Candidate15 fresh installers preserve high-water15; older recovery preserves its recorded high-water. | Positive controlled HTTPS signed16-to17update, tamper/downgrade refusal and high-water-preserving byte rollback/roll-forward pass. Real recovery inference and public feed/download verification remain pending. |

[Current exact signed-package report](verification/signed-package-source74.json) | [Signature and installation checks](VERIFICATION.md)

## Supplier-machine boundary

Buyers submit bounded inference inputs: prompt, maxTokens and seed. They do not submit executable code, kernels, model files or runtime arguments. The supplier selects a trusted, hash-pinned runtime and licensed model.

Windows CUDA retains the existing read-only file grants, private scratch, credential/environment filtering, network-denied AppContainer, authenticated relay, process limit, deadline and cleanup. CPU commitment uses a hard Job Object limit. GPU control is separate: a 250 ms watchdog sums WDDM local/dedicated and nonlocal/shared process usage and stops on excess or failed monitoring. GPU scheduling priority is idle. Before inference input is accepted, the host requires 37/37 offloaded layers and sufficient dedicated GPU usage; CPU fallback is refused.

[MIG](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/introduction.html) provides hardware memory/compute/fault partitioning for mutually untrusted tenants. It is not an inherent requirement for this fixed trusted inference workload. This Windows profile relies on the shared trusted OS, GPU and driver. It provides no hard VRAM reservation, dedicated GPU slice, throughput guarantee or hardware fault isolation. [WDDM process GPU virtual address spaces](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-virtual-memory-in-wddm-2-0) provide the OS/driver boundary. CUDA availability alone is not isolation evidence.

For the measured Windows CUDA configuration, load a policy file containing:

```json
{"model":"qwen3-4b","backend":"cuda","threads":2,"maxMemoryMb":6144,"maxGpuMemoryMb":6144,"runSeconds":180}
```

Apply it with `excess-worker policy policy.json` and use the pinned model route in [MODELS.md](MODELS.md). No public binary is published yet. The4 GiB default GPU budget was insufficient for the measured workload and correctly refused it. Do not raise limits without supplier consent or advertise an unverified model/backend.

Release signing is anonymous Minisign. Windows executables have no trusted Authenticode publisher signature; paid certificates and identity verification are outside scope. Signed metadata authenticates source/artifact hashes, not honest inference or hardware.
