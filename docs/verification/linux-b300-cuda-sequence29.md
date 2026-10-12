# Linux NVIDIA B300 CUDA evidence (0.2.2)

The signed 0.2.2 candidate (sequence 29, source `e5ff7b45439774fce78651be813a6989166fa050`, Linux archive SHA-256 `e3f525913182cc3ee3374f703d76bbdd3220ca4d5de717fd30ee5e6bcadaabb9`) ran actual buyer jobs on rented NVIDIA B300 hardware with the `linux-cuda-device-budget-v2` GPU helper. Published 0.2.2 (sequence 30) carries the same worker payload: its Linux payload fingerprint equals the one recorded in the [execution evidence](../../releases/execution-evidence.json).

## Recorded configuration

- One NVIDIA B300 SXM6 GPU (device 0), driver 580.178.04, pinned CUDA 12.9 runtime; Ubuntu kernel 7.0.0-38-generic with Landlock ABI 8.
- The worker ran as a bounded systemd user service (128 GiB memory maximum, zero swap) with a worker host memory budget of 129,024 MiB for every route. Each route had its own sampled whole-device GPU memory budget (table below). The budget is monitored with NVML. It is not a hard VRAM reservation or hardware partition.
- Temporary testnet only: three B300 runs, each on a separate machine, each created for the run and deleted afterwards (deletion confirmed through the provider API). Testnet units were used; no real funds.

## Verified models

Each listed route completed controller probe, a funded buyer job with useful output, a verified signed result and finalized accounting. Each also refused a job whose GPU budget was below the model's need, except Qwen3 Embedding 0.6B, whose adapter's policy floor prevents a lower budget.

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

Drain, restart, device revocation and cleanup passed in every run. GPU cancellation was checked per task type. A transcription job (Qwen3 ASR 0.6B) cancelled while running ended `cancelled` with no charge, and the runtime monitor recorded the runtime stopping. Cancelled text and image jobs also ended `cancelled` with no charge in the coordinator's accounting, but the harness's runtime monitor did not sample the runtime before it stopped, so those two have no monitor evidence. Embedding cancellation was not tested.

## Known limitation: streaming to a distant buyer

The buyer SDK acknowledges each streamed text chunk (eight tokens) with a separate request. A buyer far from the coordinator can therefore fall behind a fast GPU. The tests used a UK buyer, the coordinator and B300 in Kansas, and gpt-oss models. In that case the coordinator finalizes accounting on the tokens acknowledged so far, then refuses later acknowledgements with `ACCOUNTING_FINALIZED`. The supplier is paid only for acknowledged tokens. The buyer can retrieve the complete signed output from the job receipt; the live stream stops early. The gpt-oss routes passed on that basis: the streamed text was an exact prefix of the signature-verified output in the receipt. This limitation is in the coordinator and buyer SDK, not the worker.

## Scope

This evidence covers the named routes on the recorded B300 configuration only. It does not establish other NVIDIA GPUs, drivers, kernels or distributions, multi-GPU hosts, AMD or Apple GPUs, hard VRAM isolation, hardware identity or honest inference. Linux CPU and Windows evidence are recorded separately.
