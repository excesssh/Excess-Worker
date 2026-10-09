# Qwen3-14B Windows CPU buyer verification

Recorded 8 October 2026. This is operator-funded testnet verification, not organic demand, a mainnet payment or hardware/model attestation.

| Property | Recorded value |
| --- | --- |
| Worker | Published Excess Worker 0.2.0, sequence 26 |
| Release source | `8724162f793d3ec009eb2f64f713a05c29857bd7` |
| Windows archive SHA-256 | `905dd300c6922ffe28b4a83bbbf299a4000aa22b6d61cd3f944a4f2acab16173` |
| Model | Pinned Qwen3-14B Q4_K_M; llama.cpp b10809 CPU |
| Model GGUF | 9,001,752,960 bytes; SHA-256 `500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0` |
| Licence attribution | Qwen3 Apache-2.0; llama.cpp MIT |
| Configuration | Windows 11 x64, 32 GiB host; two threads, 11 GiB host cap, 300-second job limit |
| Buyer success | 80 useful billed output tokens; 65-word lighthouse-navigation answer; stream order/digests, final worker signature and receipt verified |
| Success settlement | 889 gross = 800 supplier net + 89 fee |
| Cancellation | Eight acknowledged output tokens; digest-checked provisional prefix and terminal accounted cancellation. No final result signature. |
| Cancellation settlement | 89 gross = 80 supplier net + 9 fee |

The package identity, release signature, archive digest and model/runtime installation pins were verified before pairing or execution. The recorded model hash and size identify the existing pinned GGUF; model contents are not included here.

The buyer harness's isolated pre-execution probe generated two tokens and measured 9,941 MiB peak. A separate direct published-launcher probe measured 9,939 MiB. These are separate probe observations; neither is the buyer job's measured peak or the useful buyer answer.

The jobs ran on the existing testnet with operator-funded work. Drain and fresh restart, coordinator revocation, local retirement, awaited process termination, proof retirement and owned scratch cleanup passed. The two jobs used 978 gross units. The cumulative verification ledger retained all 68 jobs and 16,724 gross units under the original 60,000 total / 7,000 per-job ceiling; the allowance was not reset. No cloud resource or new cloud spend was used for this verification.

This evidence is limited to the recorded Windows CPU route. Qwen3-14B CUDA and Linux CPU/NVIDIA remain unverified. The result does not attest honest inference or hardware identity, establish organic demand or mainnet payment, or prove support for other model routes.
