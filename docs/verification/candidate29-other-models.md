# 0.2.2 Windows and Linux CPU model routes (sequence 29 candidate)

Recorded 12 October 2026 on a temporary testnet with existing testnet units; no real funds. The signed 0.2.2 candidate (sequence 29, source `e5ff7b45439774fce78651be813a6989166fa050`) ran these jobs. Published 0.2.2 (sequence 30) has the same Windows and Linux payload fingerprints as the [execution evidence](../../releases/execution-evidence.json). This is evidence for the recorded configuration, not hardware or model attestation.

## Windows x64 (CPU and NVIDIA CUDA)

Recorded workstation: Windows 11 Pro build 22631, 32 GiB RAM, RTX 3070 Ti 8 GiB, NVIDIA driver 596.49. Each passed route completed controller probe, restart, a funded buyer job with a checked answer and a verified final signature, a cancelled job with accounting, and drain. Pairing, device revocation, local retirement, process shutdown and scratch cleanup passed for the whole journey.

| Model | Backend | Host / GPU memory budget (MiB) | Result |
| --- | --- | --- | --- |
| Qwen3-4B, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B, SD-Turbo | CPU and CUDA | CPU 4,352–8,192; CUDA 6,144 / 6,144 | Passed: the eight release-gate routes |
| Phi-4-mini | CPU | 4,608 | Passed |
| Phi-4-mini | CUDA | 6,144 / 6,144 (observed GPU peak 4,212) | Passed |
| Qwen3-8B | CPU | 7,168 | Passed |
| Qwen3-8B | CUDA | 7,168 / 6,656 (observed GPU peak 6,320) | Passed |
| Llama 3.1 8B | CPU | 7,168 | Failed: the job ran, but the answer failed the test's exact-word check within 64 tokens |
| Llama 3.1 8B | CUDA | — | Not run, because the journey stopped after the CPU failure |
| Phi-4, Qwen3-14B, gpt-oss-20b | CPU | 11,264–12,800 | Not run: the recorded workstation did not have that much free memory during the test |

The Windows text test asks for one exact word, so a correct answer is short. Journey reports: `windows-paired-media-journey-24721025-207a-43ee-bea6-a5cd5985f53a.json` (SHA-256 `3936f446b87dec368ad852869fbec33e5c0ba1ebc2cf865b91e053f4e02673fe`), which retains the eight release-gate routes verified in `windows-paired-media-journey-6ad030ac-7695-4b22-837d-937de7ac6df5.json` (SHA-256 `feace4584d650637f91042e652ec8dfb02fb9929a93294a5322fd072c7bb9755`).

## Linux x64 CPU (WSL2)

Recorded setup: Linux 6.18.40.1-microsoft-standard-WSL2, Ubuntu 24.04; two threads, zero swap, 64 tasks and CPU 200% in a dedicated systemd user unit; owner-only WSL model store. Each route completed a signed installation check, pairing, a funded buyer job (prompt: explain how a lighthouse helps sailors, 128 tokens at most), a verified final signature and accounting, a fresh restart probe, drain, device revocation, local unpairing and a cleanup audit.

| Model | Memory maximum (MiB) | Settlement (gross = supplier net + fee) | Buyer report SHA-256 |
| --- | ---: | --- | --- |
| Qwen3-4B | 8,192 | 105 = 94 + 11 | `8830aab514411c71b1ca5e6c8fb4e610ee17dc66096c7266f02984400ed4ece3` |
| Qwen3-8B | 7,168 | 126 = 113 + 13 | `ab1da106e9d03e9b139faad6ba3bfd77bf904c1c9dcf5d7ca12c687dabbcdd96` |
| Qwen3-14B | 11,264 | 123 = 110 + 13 | `35e7249b0af9e6268d7516de2044c350c868213de02a82c90b20ca5db23e90a2` |

The three routes ran serially in one journey (`sequence29-e5ff7b454397-linux-buyer-journey.json`, SHA-256 `06ad3b615f4d6054fdda2d69f9221b9c5c54168a9a74ba3e46ea5ed3bee410ba`; cleanup audit SHA-256 `37b407e362f867bb22f29480d173be906470fbb09b3061575891d1d79c61b4f4`). The execution evidence binds the Qwen3-4B route.

## Scope

These results cover the named routes on the recorded workstation and WSL2 setup. Other Windows or Linux configurations, other GPUs and the routes marked failed or not run are unverified. Linux NVIDIA CUDA is recorded separately in the [B300 record](linux-b300-cuda-sequence29.md).
