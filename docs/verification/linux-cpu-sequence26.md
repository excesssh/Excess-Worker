# Published sequence-26 Linux WSL CPU buyer evidence

This record covers two successful CPU buyer routes using the signed published Excess Worker 0.2.0 package (sequence 26). It is scoped to the recorded Linux x64 environment under WSL. See also [supported configurations](../PLATFORMS.md#published-sequence-26-linux-wsl-cpu-evidence) and [model installation](../INSTALLATION.md#choose-and-install-a-model).

## Package identity

- Release: [Excess Worker 0.2.0](https://github.com/excesssh/Excess-Worker/releases/tag/v0.2.0)
- Sequence: 26
- Source commit: [8724162f793d3ec009eb2f64f713a05c29857bd7](https://github.com/excesssh/Excess-Worker/commit/8724162f793d3ec009eb2f64f713a05c29857bd7)
- Published archive SHA-256: 446a98d1fb14fcc568c8a8856ff5e59fd1c2e1d19a4cdb58021134c5dcb3c268
- Signed manifest SHA-256: d2eaa9a53be7c33d507b558501b4a89a0baa44772ef9ca4432a53d5d8e78c565

## Recorded configuration and results

Both routes used the CPU backend and two worker threads. The pinned route harness set and read back a worker runSeconds cap of 300 seconds per job. The enclosing systemd user-service cgroup v2 limits were MemoryMax=8G, MemorySwapMax=0, TasksMax=64, CPUQuota=200%, RuntimeMaxSec=600 and TimeoutStopSec=15. The post-restart probe verified the same service limits. The reports identify Linux x64 under WSL; they do not pin a processor model or establish host-specific performance.

| Model | Task | Outcome | Retained route-report SHA-256 |
| --- | --- | --- | --- |
| Qwen3 Embedding 0.6B | Embeddings | Passed; meaningful output, valid result proof and buyer accounting reconciled separately. | 6f37404b652b798191065920959e67edce0a69e070462906453af9bba3589ba6 |
| Qwen3 ASR 0.6B | Transcription | Passed; meaningful output, valid result proof and buyer accounting reconciled separately. | 9adb35f62db690de487f4ef36619d2237f0987796b1f595128c6fc4c7b7fc027 |

For each route, the report records verification of the signed sequence-26 worker and CPU model plan, pinned CPU model/runtime materialization, and device pairing. The result proof and output signature passed. The signature scope is the verified output only and does not cover accounting; buyer accounting was checked separately and reconciled. The pinned harness issued a drain before each worker stop and awaited process closure; its cleanup guard required the service unit to stop and the cgroup to empty before a route report could pass. The reports directly record worker exit code 0, a post-restart probe under the same service limits, device revocation, local unpair, unchanged model-store contents and removed run scratch.

## Limits of this evidence

These are two actual WSL CPU buyer routes. They do not establish native bare-metal Linux or general distribution compatibility, execution for other catalogue models, Linux GPU support, hardware identity or honest inference. The existing Qwen3-4B Linux buyer result remains sequence-25 evidence. No successful Linux Qwen3-8B result is claimed in this record.

The SHA-256 values above identify retained verification reports for this checkpoint. The report files themselves are not distributed in this public repository, so the digests alone do not provide independent access to the underlying operational records.
