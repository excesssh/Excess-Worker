# Windows candidate coverage

Published Worker 0.1.0 archives remain unchanged. Unpublished 0.2.0 sequence 24, source `7a33c1b51a12fea87601e3d81d5a9b1b114588d6`, passed eight actual packaged-worker Windows testnet buyer routes on the recorded Windows 11 x64 / RTX 3070 Ti 8 GiB / driver 596.49 workstation. These are candidate results, not support claims for 0.1.0 or a published successor. [Exact evidence summary](verification/windows-source90.json).

| Candidate24 model/task | CPU buyer job | CUDA buyer job |
| --- | --- | --- |
| Qwen3-4B / text | Passed | Passed |
| Qwen3 Embedding 0.6B / embeddings | Passed | Passed |
| Qwen3 ASR 0.6B / transcription | Passed | Passed |
| SD-Turbo / images | Passed | Passed on retry; first delivery failure retained |
| FLUX.1 schnell / images | GPU required; refused on CPU | Not tested; 12 GiB estimate exceeds this 8 GiB GPU |

The latest passing routes record signed buyer results, exact accounting, live cancellation, drain, restart where required, revocation, ordinary CLI retirement and awaited process/proof/scratch cleanup. CPU image inference used eight threads, 8 GiB host memory and a 300-second limit. CUDA media used two threads, 8 GiB host and a separate 6 GiB monitored GPU budget. Model installation, hardware-fit estimates and adapter probes are separate from these buyer results.

## Retained CUDA delivery failure

The first CUDA SD-Turbo attempt produced its inference proof/artifact at 15:39:04.995 UTC on 8 October 2026, before its renewed completion lease ended at 15:39:31.691 UTC. The coordinator nevertheless recorded `failed` / `lease_expired`, `delivery_started=false`, and zero billed units. The attempt journal stopped at `running`; no result-pending entry was written. Initial CLI retirement and cleanup checks failed. The device was revoked and independent physical process stop and retained-state quarantine subsequently passed.

One bounded diagnostic retry passed with the same product bytes. That retry does not establish the first failure's cause or a fix. The original evidence remains retained. A targeted transition reproduction and repeated actual post-fix packaged-worker buyer jobs remain required before release.

## Runtime and coverage limits

The Windows image CUDA executable, runtime archive and DLL archive independently match between builds A and B. CPU image binaries/archives also match. Runtime pin reproducibility is scoped separately from execution; see the [Windows image build recipe](windows-image-runtime-reproducibility/README.md). No independent rebuild of upstream models, drivers or operating systems is claimed.

The trusted host binds operations to the assignment, task, capability and request digest, validates bounded audio, result units and artifact transfers, retains scoped execution proofs for lost-receipt recovery, and keeps signing keys outside both isolated processes. GPU monitoring is sampled and supplies no hard VRAM reservation or hardware fault partition.

All 13 text entries retain pinned model/runtime bytes. Twelve other text entries remain without Windows buyer-job evidence. FLUX.1 schnell remains untested on this GPU. All 17 Linux CUDA entries remain untested; [Linux candidate coverage](linux-cuda-catalogue-coverage.md) is separate. Recorded 0.1.0 Qwen3-4B CPU/CUDA evidence certifies its earlier payload only.
