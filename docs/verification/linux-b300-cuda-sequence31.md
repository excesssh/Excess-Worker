# Linux NVIDIA B300 CUDA evidence (0.2.3)

The signed 0.2.3 candidate (sequence 31, source `2b674596b029cd1d76be13c390fa75962b3ad561`, Linux archive SHA-256 `53250b19e415fb8f132b15223e1b57c8b3e475af2bd35fb5e2900e284f2a892f`) ran actual buyer jobs on rented NVIDIA B300 hardware with the `linux-cuda-device-budget-v2` GPU helper. Published 0.2.3 (sequence 32) carries the same worker payload: its Linux payload fingerprint equals the one recorded in the [execution evidence](../../releases/execution-evidence.json).

## Recorded configuration

- One NVIDIA B300 SXM6 GPU (device 0), driver 580.178.04, pinned CUDA 12.9 runtime; Ubuntu kernel 7.0.0-38-generic with Landlock ABI 8.
- The worker ran as a bounded systemd user service (128 GiB memory maximum, zero swap) with a worker host memory budget of 129,024 MiB for every route. Each route had its own sampled whole-device GPU memory budget (table below). The budget is monitored with NVML. It is not a hard VRAM reservation or hardware partition.
- Temporary testnet only: two runs on one B300 machine, created for this release and deleted afterwards (deletion confirmed through the provider API). An earlier machine stopped on a model start timeout before the matrix finished; it was also deleted and none of its results are used. Testnet units were used; no real funds.
- The buyer ran in the UK against a coordinator in London; the B300 was in Kansas.

## Verified models

Each listed route completed controller probe, a funded buyer job with useful output, a verified signed result and finalized accounting. Each also refused a job whose GPU budget was below the model's need, except Qwen3 Embedding 0.6B, whose adapter's policy floor prevents a lower budget. gpt-oss-120b failed in the first run because the buyer's wallet session expired, and passed in the second run on the same machine; every other model passed in the first run.

| Model | Task | GPU memory budget (MiB) | Observed peak (MiB) |
| --- | --- | ---: | ---: |
| Phi-4-mini | Text | 8,192 | 5,433 |
| Qwen3 ASR 0.6B | Transcription | 8,192 | 4,377 |
| Qwen3 Embedding 0.6B | Embedding | 8,192 | 3,467 |
| Qwen3-4B | Text | 8,192 | 5,805 |
| SD-Turbo | Image | 8,192 | 3,839 |
| Llama 3.1 8B | Text | 10,752 | 7,717 |
| Qwen3-8B | Text | 10,752 | 7,893 |
| Phi-4 | Text | 15,872 | 12,259 |
| Qwen3-14B | Text | 15,872 | 11,863 |
| gpt-oss-20b | Text | 17,408 | 13,957 |
| Qwen3-30B-A3B-Instruct-2507 | Text | 26,624 | 20,471 |
| Qwen3-Coder-30B-A3B | Text | 26,624 | 20,471 |
| Qwen3-30B-A3B | Text | 27,136 | 20,571 |
| Qwen3-32B | Text | 29,184 | 23,289 |
| FLUX.1 schnell | Image | 32,768 | 12,663 |
| Llama 3.3 70B | Text | 57,344 | 45,373 |
| gpt-oss-120b | Text | 78,848 | 62,967 |

## Lifecycle and cancellation

Drain, restart and cleanup passed in both runs. Device revocation passed in the second run. In the first run the matrix's own revocation step failed because the buyer's wallet session had expired; that device was revoked afterwards with a fresh session and the revocation was confirmed.

GPU cancellation was checked for all four task types, each in the first run. Embedding (Qwen3 Embedding 0.6B) and transcription (Qwen3 ASR 0.6B) jobs cancelled while running ended `cancelled` with no charge, and the runtime monitor recorded the runtime stopping. Cancelled text and image jobs also ended `cancelled` with no charge in the coordinator's accounting, but the harness's runtime monitor did not sample the runtime before it stopped, so those two have no monitor evidence.

## Streamed text

The 0.2.2 record noted that the buyer SDK waited for a round trip after acknowledging each streamed text chunk, so a distant buyer could fall behind a fast GPU. The SDK now keeps one cumulative acknowledgement in flight and sends the final one before it accepts the terminal receipt; every chunk is still verified before it is acknowledged. In these runs every text route, including gpt-oss-20b and gpt-oss-120b, completed through the plain SDK stream: the coordinator's accounting acknowledged every produced token (879 for gpt-oss-20b, 1,027 for gpt-oss-120b) and the result signature verified. The buyer was close to the coordinator in these runs, so they do not show how a distant buyer keeps up with a fast GPU. A later Windows test with a buyer about 1.5 seconds from the coordinator completed every stream with the 0.2.3 SDK; see the [Windows streaming and cancellation record](windows-streaming-cancellation-0.2.3.md).

## Scope

This evidence covers the named routes on the recorded B300 configuration only. It does not establish other NVIDIA GPUs, drivers, kernels or distributions, multi-GPU hosts, AMD or Apple GPUs, hard VRAM isolation, hardware identity or honest inference. Linux CPU and Windows evidence are recorded separately.
