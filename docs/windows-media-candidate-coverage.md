# Windows media candidate coverage

The published Worker0.1.0 archives remain unchanged. This source adds sealed Windows media routes to the0.2.0 candidate. Adapter probes below do not establish a paired-worker buyer journey, clean installation, another model or a published successor. New binary distribution remains gated.

| Model/task | Confined CPU adapter probe | Confined CUDA adapter probe | Changed-payload paired buyer job |
| --- | --- | --- | --- |
| Qwen3 Embedding0.6B / embeddings | passed,8 GiB host,2 threads | passed,8 GiB host,6 GiB monitored GPU budget,29 fully offloaded layers | pending |
| Qwen3 ASR0.6B / transcription | passed,4 GiB host,2 threads | passed,8 GiB host,6 GiB GPU budget,29 fully offloaded layers | pending |
| SD-Turbo / images | passed,8 GiB host,8 threads,300-second limit; about194 seconds | archive-A probe passed,8 GiB host,2 threads,6 GiB GPU budget; about19 seconds inference,3818 MiB dedicated peak; runtime and DLL archive A/B hashes match | pending |
| FLUX.1 schnell / images | GPU-only; refused | untested; exceeds the recorded RTX3070Ti8 GiB hardware estimate | pending |

Measurements were recorded on Windows x64 with an RTX3070Ti and driver596.49. The CUDA executable, runtime archive and separate DLL archive independently match between builds A and B. Only runtime archive A has a recorded SD-Turbo adapter probe; build equality does not establish archive-B execution or a paired buyer job. CPU image binaries/archives already match in two build directories. Source and runtime pins, original licences and the [Windows image build recipe](windows-image-runtime-reproducibility/README.md) scope reproducibility separately from execution. Linux GPU coverage is recorded separately in [its candidate coverage table](linux-cuda-catalogue-coverage.md).

The trusted host binds every operation to the assigned task, capability and request digest. It validates bounded audio, result units and artifact transfers, retains scoped execution proofs for lost-receipt recovery, and keeps device signing keys outside both isolated processes. Cancellation, drain, restart, revocation and cleanup still require paired-job verification for this changed payload.

Selection preserves catalogue estimates and checks explicit execution-profile budgets. Windows CPU embedding/image profiles require an8 GiB host cap; SD-Turbo CPU requires at least300 seconds. A larger bounded embedding input reaps the previous runtime before increasing physical batch allocation. Earlier low-memory, excessive-workspace, relay-deadline and CUDA linker failures are retained privately as failed evidence.

All13 text entries retain their pinned model/runtime bytes. Models beyond this workstation's host/VRAM estimates remain untested here. Recorded0.1.0 Qwen3-4B CPU/CUDA evidence certifies its exact earlier payload only.
