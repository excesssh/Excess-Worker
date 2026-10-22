# Remaining-work checklist

[Excess Worker 0.2.3](https://github.com/excesssh/Excess-Worker/releases/tag/v0.2.3) (sequence 32) is published. Its buyer routes are attributed to signed candidate31 with matching sequence-32 payloads; see the [0.2.3 model route record](candidate31-other-models.md) and the [B300 record](linux-b300-cuda-sequence31.md). Earlier items below record 0.2.0 evidence. Checked items record completed release evidence; unchecked catalogue gaps limit claims and do not imply broader execution.

## Implementation faults

- [x] The repeated-job observer was corrected for the coordinator’s `items` response envelope and multiline close diagnostics. The original incomplete repeat-run report and its missing-observation reasons remain preserved; the post-run append-only reconciliation records five successful, signed, accounted buffered-media jobs.
- [x] A separate native admission-ordering regression was reproduced with bounded fixture controls and fixed.
- [ ] Three Windows faults in published 0.2.3 are fixed on `main` but not released: non-ASCII prompts and output fail, a warm runtime is stopped at the job limit after it started, and the worker stops after a failed job. They need a 0.2.4 release and a live recheck (non-ASCII prompt, a job more than 300 seconds after the runtime started, and a failed job followed by another). See the [Windows streaming and cancellation record](windows-streaming-cancellation-0.2.3.md).
- [ ] Untested: the Linux CPU sandbox time limit counts CPU time across all runtime threads, so a long-lived Linux CPU runtime may still be stopped after 605 CPU-seconds in total.
- Historical incident: the cause of the first candidate24 CUDA delivery failure remains unestablished. Its recorded terminal state is `failed` / `lease_expired`, with zero billed units and no local `result_pending` or authenticated terminal-accounting row. The stream-specific `deliveryStarted=false` field does not establish buffered-artifact non-delivery. Do not claim the later harness or native fix resolved it.

## Missing execution evidence

- [x] Windows: four model/task routes (Qwen3-4B text, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and SD-Turbo images) each passed actual packaged-worker CPU and CUDA buyer jobs on candidate25; five additional serial SD-Turbo CUDA buyer jobs passed signed-artifact and accounting reconciliation. Sequence26 matched execution payload fingerprints for both platform packages. Fresh sequence 26 Windows install, authenticated update, CPU/CUDA recovery and cleanup checks passed. Runtime recovery probes are not buyer jobs.
- [ ] Windows catalogue breadth: 0.2.3 passed Phi-4-mini, Qwen3-8B and Llama 3.1 8B on CPU and CUDA, and Phi-4, Qwen3-14B and gpt-oss-20b on CPU. Phi-4, Qwen3-14B and gpt-oss-20b have no Windows CUDA job: their measured GPU peaks exceed the recorded 8 GiB GPU. The 30B and larger text entries and FLUX.1 schnell have no Windows buyer job on 0.2.3. Do not claim support or fit for that configuration.
- [x] Linux CPU: Qwen3-4B passed on candidate25 under the recorded WSL2 limits. Published sequence 26 separately passed Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and Qwen3-8B CPU buyer routes under WSL; see the [embedding/ASR record](linux-cpu-sequence26.md) and [Qwen3-8B record](qwen3-8b-linux-wsl-cpu.md). Sequence 26 Linux direct installation and update/recovery also passed.
- [ ] Linux CPU breadth: 0.2.3 (as 0.2.2) passed Qwen3-4B, Qwen3-8B and Qwen3-14B CPU buyer jobs under WSL2. The other CPU-eligible local entries have no Linux CPU buyer job on 0.2.3; FLUX.1 schnell has no CPU backend.
- [x] Keep the 17 pinned local catalogue entries (13 text, four media) separate from the 43 hosted-provider entries. Catalogue availability, estimated fit, installability, runtime probes and buyer execution are distinct evidence.

## External access and capacity blockers

- [x] Linux CUDA: all 17 pinned local models passed actual buyer jobs on one recorded NVIDIA B300 configuration with the 0.2.2 and 0.2.3 candidates. Other GPUs, drivers and distributions remain unverified. On 0.2.3, cancelled jobs of all four task types ended with no charge; text and image cancellation still lack runtime-monitor evidence on Linux.
- [x] Windows 0.2.3, RTX 3070 Ti: cancelling text on CPU and CUDA stopped the runtime within about 0.45 seconds, and cancelling a CPU image within about 5 seconds; a CUDA image at the market maximum finishes in about 2 seconds, before cancellation can reach it. A buyer about 1.5 seconds away completed every stream with the 0.2.3 SDK and failed with the 0.2.2 SDK. [Recorded evidence](windows-streaming-cancellation-0.2.3.md).
- [x] This capacity blocker does not block the scoped Windows release or the verified Linux CPU/install/update claims. Any later Linux CUDA claim requires actual Linux NVIDIA execution and buyer evidence.
- [x] Published sequence 26 Qwen3-8B Windows CPU buyer lifecycle: useful signed output, acknowledged-prefix cancellation, exact settlement/supplier earnings, drain/restart, revocation and cleanup. Two threads/10 GiB/300-seconds. [Recorded evidence](qwen3-8b-windows-cpu.md).
- [x] Published sequence 26 Qwen3-14B Windows CPU buyer lifecycle: 65 useful words/80 billed tokens, eight acknowledged, digest-checked provisional cancellation-prefix tokens, exact settlement, drain/restart, revocation and cleanup. Operator-funded testnet, Windows 11 x64, two threads/11 GiB/300 seconds. [Recorded evidence](qwen3-14b-windows-cpu.md).

- [x] Published sequence 26 Phi-4-mini Windows CPU and CUDA buyer lifecycles: useful signed output, acknowledged provisional-prefix cancellation, exact accounting and cleanup. Two threads/8 GiB host/6 GiB CUDA/300 seconds on the recorded RTX 3070 Ti. [Recorded evidence](phi4mini-windows.md).
