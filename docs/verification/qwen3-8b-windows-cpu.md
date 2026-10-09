# Qwen3-8B Windows CPU buyer verification

Recorded 8 October 2026. This is operator-funded testnet verification, not organic demand, a mainnet payment or hardware/model attestation.

| Property | Recorded value |
| --- | --- |
| Worker | Published Excess Worker 0.2.0, sequence 26 |
| Release source | `8724162f793d3ec009eb2f64f713a05c29857bd7` |
| Windows archive SHA-256 | `905dd300c6922ffe28b4a83bbbf299a4000aa22b6d61cd3f944a4f2acab16173` |
| Model | Pinned Qwen3-8B Q4_K_M; llama.cpp b10809 CPU |
| Configuration | Windows 11 x64, 32 GiB host; two threads, 10 GiB host cap, 300-second job limit |
| Success | Useful 116-token explanation of lighthouse navigation; final worker signature verified |
| Success accounting | 1,289 gross = 1,160 supplier net + 129 fee |
| Cancellation | Eight acknowledged output tokens; SDK-verified digest-checked provisional prefix, terminal accounted cancellation; no final output signature |
| Cancellation accounting | 89 gross = 80 supplier net + 9 fee |

The complete signed-package inventory, previously established anonymous Minisign key, release signature, archive digest and model/runtime installation pins were checked before pairing or execution. A new scoped device completed the jobs on the existing testnet. Supplier earnings matched both jobs. Drain and fresh restart, coordinator revocation, CLI local retirement, awaited process termination, proof retirement and owned scratch cleanup passed.

The two jobs cost 1,378 EXTEST base units under the existing 60,000 total / 7,000 per-job verification ceiling. They did not create a cloud resource, deposit funds or send a mainnet transaction. The private cumulative verification ledger retained all 64 jobs rather than resetting earlier spending.

This is evidence for the recorded Windows CPU configuration. Qwen3-8B CUDA, Linux CPU and Linux NVIDIA remain unverified. Four other model/task routes retain their separate Windows CPU/CUDA evidence; all 17 Linux NVIDIA catalogue routes still require actual fitting hardware. A signature authenticates the recorded message, not honest execution or hardware. Independent security review remains external.
