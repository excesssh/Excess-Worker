# Phi-4-mini Windows CPU and CUDA buyer verification

Recorded 9 October 2026. The published Excess Worker 0.2.0, sequence 26 completed two useful buyer jobs and two cancellation jobs on operator-funded testnet. This is evidence for the recorded configuration, not hardware or model attestation.

| Property | Recorded value |
| --- | --- |
| Release source | `8724162f793d3ec009eb2f64f713a05c29857bd7` |
| Windows archive SHA-256 | `905dd300c6922ffe28b4a83bbbf299a4000aa22b6d61cd3f944a4f2acab16173` |
| Model | Phi-4-mini 3.8B, pinned GGUF, llama.cpp b10809 |
| Model bytes / SHA-256 | 2,491,874,272 / `88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a` |
| Licences | Phi-4-mini MIT; llama.cpp MIT |
| Host | Recorded Windows x64 workstation, 32 GiB RAM, RTX 3070 Ti with 8 GiB VRAM |
| Worker controls | Two threads, 8 GiB host cap, 300-second job limit; CUDA memory budget 6 GiB |
| CPU useful result | 128 billed tokens, 111 words; lighthouse, sailors and charts terms checked; final worker signature verified |
| CUDA useful result | 128 billed tokens, 110 words; same usefulness checks; final worker signature verified |
| Each successful settlement | 1,423 gross = 1,280 supplier net + 143 fee |
| Each cancellation | Eight acknowledged, digest-checked provisional tokens; cancelled/accounted; no final output signature |
| Each cancellation settlement | 89 gross = 80 supplier net + 9 fee |

The established project key, release signature, archive hash, installed file inventory and model/runtime pins were checked before execution. Explicit licence and runtime consent was retained. The original hash-pinned model and licence bytes were preserved; generic tokenizer vocabulary was handled by the specialised model inspection route.

Drain, restart, exact device revocation, local retirement, awaited process termination and owned scratch cleanup passed. All four jobs reconciled holds and supplier earnings; their total was 3,024 gross units. The cumulative verification ledger retained 72 jobs / 19,748 gross units under its original 60,000 total / 7,000 per-job ceiling.

The [execution summary](phi4mini-windows.json) includes job IDs, output/proof hashes, accounting and lifecycle observations. It is an extracted report, not a substitute for a signed receipt or an independent review. Stream chunks carry verified digests and ordering; they do not carry individual device signatures. Successful final output signatures authenticate the recorded device fields. Cancellation leaves its acknowledged prefix provisional.

This record adds Windows CPU and the recorded Windows CUDA route. Linux CPU/NVIDIA, other GPUs and larger-model fit remain separate verification requirements.
