# Windows model and media candidate coverage

The published [0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) and its evidence remain unchanged. The Windows buyer results here apply to the exact signed candidate25 package, source `f07ffd9c6c447ed8f60fd258807a0f7d487796b4`, sequence 25, Windows archive SHA-256 `34d3febd9c64a1fe968101cfa6932d8a6dd33e50cbdffd7dcf1090195536ebd6`. The candidate-only eight-route report ended at 17:34:12 UTC with route success, cancellation, drain and shared cleanup passed (report SHA-256 `c7efe17c97de538a6fa0df9c62f39c08f6a2e4671a11a59c479971d98ec4c84a`). The sequence26 build report matched executable, native, dependency, launcher and licence payload fingerprints to prepared sequence25 execution evidence for both platform archives (SHA-256 `24ff8dbcbfbd6b2454c68b87c3facc615af3a98d70bd089487efbfb7cf743ff4`). Fresh direct sequence26 Windows installation passed with 340 files fully hashed, high-water 26, actual Minisign verification and the expected ready launcher (SHA-256 `90332df782245a29ab8f7bd66fb9ba49cfefbd2be6fe99033effd993c9926559`); Linux direct installation passed with 343 files fully hashed.

| Candidate25 model/task | CPU buyer route | CUDA buyer route |
| --- | --- | --- |
| Qwen3-4B / text | Passed | Passed |
| Qwen3 Embedding 0.6B / embeddings | Passed | Passed |
| Qwen3 ASR 0.6B / transcription | Passed | Passed |
| SD-Turbo / images | Passed | Passed |
| FLUX.1 schnell / images | GPU required; no buyer route | No buyer route; 12 GiB VRAM estimate exceeds the recorded 8 GiB GPU |

The eight passing routes used actual packaged-worker buyer jobs on the recorded Windows 11 x64 / RTX 3070 Ti 8 GiB / driver 596.49 workstation. Their exact route report records buyer results, accounting, cancellation, drain, restart where required, revocation, ordinary CLI retirement and awaited process/proof/scratch cleanup. They do not establish other Windows machines, GPUs, drivers or Linux support.

## Repeated SD-Turbo CUDA buyer jobs

Five additional serial SD-Turbo CUDA jobs used the same exact candidate25 package. They returned signed artifacts and accounted receipts. A separate post-run API audit records all five authoritative job states as `succeeded`. The append-only buffered-media reconciliation (SHA-256 `25b5b3d1c5e320b7d59ab33cda9a330117ddb4c1c14d975ed1f795e38b95f6c3`) binds each job and attempt to its device, capability, host proof, complete `seen → running → result_pending → finished` attempt chain, fetched artifact, verified signed receipt, terminal accounting and supplier earnings. Each result-pending record precedes the captured host-proof completion lease.

The original repeat-run report remains failed with `OWNED_JOB_ASSIGNMENT_STATE_MISSING` and keeps `AUTHORITATIVE_DELIVERY_NOT_OBSERVED` for all five local characterizations. The append-only reconciliation does not rewrite that report. A separate queued, unassigned cancellation refund was reconciled; it confirms released funds but does not pass an in-flight cancellation gate. The API audit's `deliveryStarted=false` flag is stream-specific; it is preserved as false and does not establish that buffered image delivery failed. Its API inspection timestamps were collected after the repeat run completed and are reported as such.

## Earlier CUDA delivery failure and targeted fix

The first candidate24 SD-Turbo CUDA attempt produced an inference proof/artifact at 15:39:04.995 UTC on 8 October 2026, before its renewed completion lease ended at 15:39:31.691 UTC. The coordinator recorded `failed` / `lease_expired`, `delivery_started=false`, and zero billed units. The attempt journal stopped at `running`; it had no `result_pending` row or authenticated terminal receipt/accounting. The flag describes the streaming path and does not establish whether buffered image output reached the buyer. The cause of that first failed job remains unestablished. A same-source retry passed, and the later candidate25 results do not explain the original failure. See the [retained candidate24 evidence](verification/windows-source90.json).

A bounded native fixture reproduced an admission-ordering regression and verified its fix with targeted controls. This establishes a separate implementation fault and its correction. It does not establish that the regression caused the earlier CUDA delivery failure.

## Catalogue and hardware limits

The local catalogue has 17 pinned entries: 13 text and four media models. Twelve other text entries have no Windows buyer execution evidence. FLUX.1 schnell requires GPU and its 12 GiB VRAM estimate exceeds the recorded 8 GiB GPU; it has no buyer route on this configuration. Catalogue presence, estimated fit, model installation, runtime probes and buyer execution remain distinct evidence.

All 17 local entries remain without Linux CUDA execution evidence. Linux CUDA is candidate-unverified; this page makes no Linux GPU support claim. A Qwen3-4B Linux CPU buyer job passed on signed sequence25 under WSL2 Linux 6.18.40.1, regular UID 1000, 2 threads, 8 GiB cgroup v2 memory, zero swap, 64 tasks and CPU 200% (report SHA-256 `69ad5c07769137a361122a3fd461f1c29adfbc09c2980da02c89152ffc4843ef`). The sequence26 build report matched its execution payload fingerprints, and a separate sequence26 update/recovery run passed a CPU probe. A fresh signed sequence26 Linux installation passed with all 343 files hash-verified, executable modes checked, high-water 26 and no owned runtime processes. These results do not establish Linux CUDA support or general Linux distribution compatibility; the other 16 local models have no Linux CPU buyer job. The published 0.1.0 Qwen3-4B Windows and WSL2 CPU/CUDA results certify only that earlier payload. The 43 hosted-provider catalogue entries are a separate service and are not local worker installs. See [platform evidence](PLATFORMS.md), the [full local catalogue](MODEL-CATALOG.md), and the [Linux CUDA catalogue coverage](linux-cuda-catalogue-coverage.md).
