# 0.2.3 Windows and Linux CPU model routes (sequence 31 candidate)

Recorded 21 October 2026 on a temporary testnet with existing testnet units; no real funds. The signed 0.2.3 candidate (sequence 31, source `2b674596b029cd1d76be13c390fa75962b3ad561`) ran these jobs. Published 0.2.3 (sequence 32) has the same Windows and Linux payload fingerprints as the [execution evidence](../../releases/execution-evidence.json). This is evidence for the recorded configuration, not hardware or model attestation.

## Windows x64 (CPU and NVIDIA CUDA)

Recorded workstation: Windows 11 Pro build 22631, 32 GiB RAM, RTX 3070 Ti 8 GiB, NVIDIA driver 596.49. Each passed route completed controller probe, restart, a funded buyer job with a checked answer and a verified final signature, a cancelled job with accounting, and drain. Pairing, device revocation, local retirement, process shutdown and scratch cleanup passed for the whole journey.

| Model | Backend | Host / GPU memory budget (MiB) | Observed peak (MiB) | Result |
| --- | --- | --- | --- | --- |
| Qwen3-4B, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B, SD-Turbo | CPU and CUDA | CPU 4,352–8,192; CUDA 6,144 / 6,144 | — | Passed: the eight release-gate routes |
| Phi-4-mini | CPU | 4,608 | host 3,474 | Passed |
| Phi-4-mini | CUDA | 6,144 / 6,144 | GPU 4,212 | Passed |
| Qwen3-8B | CPU | 7,168 | host 6,013 | Passed |
| Qwen3-8B | CUDA | 7,168 / 6,656 | GPU 6,318 | Passed |
| Llama 3.1 8B | CPU | 7,168 | host 5,792 | Passed |
| Llama 3.1 8B | CUDA | 7,168 / 6,656 | GPU 6,100 | Passed |
| Phi-4 | CPU | 11,264 | host 10,286 | Passed |
| Qwen3-14B | CPU | 11,264 | host 9,932 | Passed |
| gpt-oss-20b | CPU | 12,800 | host 11,885 | Passed |

The Windows text test asks for one exact word, so a correct answer is short. For Llama 3.1 8B the prompt is a direct question (name the tall coastal tower whose light guides ships at night); with the shorter instruction used for the other models, Llama answered that no question had been given. The answer check itself is unchanged.

Journey report: `windows-paired-media-journey-e1cccd41-7568-4051-8787-e94ae1184855.json` (SHA-256 `c3236a858135418e83451c0b6251a3b5fe8dba8f21ebb5fa9cedc43079cc03bf`). It ran all nine additional routes and retains the eight release-gate routes verified in `windows-paired-media-journey-0b0438af-0dde-4544-9fda-4f0d66f99af6.json` (SHA-256 `978a2208a924763d1620bac33e3d4b7d319a8343bbe6a84d8bddf467bc003a9b`), which itself retains the Qwen3-4B CPU route from `windows-paired-media-journey-eacf4008-eb31-4c35-9f17-872321a9b68f.json` (SHA-256 `04d928484b790f1fa781ccaeadfdb4170a4c666b1903a2b337cf9620b8feb12b`). That earlier journey stopped during a CUDA cancellation check because a coordinator quality-check job was assigned to the same device at the same time, which changed the supplier earnings the check compares; no worker fault was found.

## Linux x64 CPU (WSL2)

Recorded setup: Linux 6.18.54.1-microsoft-standard-WSL2, Ubuntu 24.04; two threads, zero swap, 64 tasks and CPU 200% in a dedicated systemd user unit; owner-only WSL model store. Each route completed a signed installation check, pairing, a funded buyer job (prompt: explain how a lighthouse helps sailors, 128 tokens at most), a verified final signature and accounting, a fresh restart probe, drain, device revocation, local unpairing and a cleanup audit.

| Model | Memory maximum (MiB) | Settlement (gross = supplier net + fee) | Buyer report SHA-256 |
| --- | ---: | --- | --- |
| Qwen3-4B | 8,192 | 105 = 94 + 11 | `b7092b7aa61869cfeaafec945bf2129434f8cb819bd87416e3a80f47df1255be` |
| Qwen3-8B | 7,168 | 126 = 113 + 13 | `f4f4721933592edd8289cfbe0b3fe52da00d7329496571709f096a52cf647c07` |
| Qwen3-14B | 11,264 | 123 = 110 + 13 | `72b9b1e8cfeb65ad481d4af8ab3f7f008a543df618e3bf849d6305582ea33c41` |

The three routes ran serially in one journey (`sequence31-2b674596b029-linux-buyer-journey.json`, SHA-256 `9d2f8ce143bed8b94a31782d2b083d673ba11dbde1a6c4346ec03a5d98fd6e11`; cleanup audit SHA-256 `b7be65fd1de743f4dd3ae191a58a1a6349f24cf0ec7fe653f822de3a716ab7ba`). The execution evidence binds the Qwen3-4B route. A further Qwen3-4B job on the same setup was used only to observe the Linux controller boundary.

## Scope

These results cover the named routes on the recorded workstation and WSL2 setup. Other Windows or Linux configurations and other GPUs are unverified. Linux NVIDIA CUDA is recorded separately in the [B300 record](linux-b300-cuda-sequence31.md).
