# Security

## Reporting

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/excesssh/Excess-Worker/security/advisories/new), enabled for this repository. It reaches the project maintainers without publishing the report. Use a pseudonymous GitHub account if you want to avoid disclosing a personal identity; GitHub requires sign-in and can associate the report with that account. This is not an account-free or provider-anonymous channel. No personal contact address is required or published.

Include the affected version/configuration, impact and minimal reproduction. Do not upload device state, private keys, wallet secrets, personal paths or unredacted logs. Keep exploitable details out of public issues. Coordinate disclosure through the private report; no response-time or bounty promise is made. GitHub initially credits the reporting account in a proposed advisory; review attribution with maintainers before disclosure. [GitHub reporting details](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

## Supported release

The current published worker release is [0.1.0](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0). Its verified configurations and real execution evidence are in [platform status](docs/PLATFORMS.md) and [release verification](docs/VERIFICATION.md#current-evidence). Earlier source previews and local closed candidates are historical development artifacts.

## Sensitive local data

Pairing creates a revocable Ed25519 machine credential for worker messages. It cannot authorize wallet spending or withdrawals; those require separate wallet approvals on the website. The private key is protected with current-user DPAPI on Windows and mode 0600 on Linux. Keep the state directory restricted to the worker account, and never upload it with a report.

The separate model runtime receives no machine key. On Windows, the trusted host retains that key and performs typed signing operations; the controller receives no identity-file grant. On Linux, the isolated Node controller can read the device credential through read-only state and signs allowed device messages; a narrow host broker mediates state writes. [Controller and credential architecture](docs/ARCHITECTURE.md).

Revoke a device through the Supply page to remove coordinator access. After outstanding work is handled, `unpair` retires its local identity and pending result files. [Stop and revocation instructions](docs/INSTALLATION.md#stop-revoke-and-update).

## Model-runtime boundaries

Buyers submit bounded inference data, not executable code, model files, kernels or arbitrary runtime arguments. The supplier selects a pinned model/runtime. Selected runtime and model files are exposed read-only; private scratch is writable. Direct runtime network access is denied. Unsupported or missing required boundary features refuse execution.

Windows uses a pinned AppContainer controller, bounded typed host broker and separate model AppContainer. The host limits coordinator operations to the paired origin and retains device signing and managed state. Linux uses private namespaces, Landlock/seccomp restrictions, read-only mounts, bounded scratch and a dedicated finite cgroup v2 user service; authenticated host brokers mediate coordinator access and state writes. [Detailed boundaries and fixture scope](docs/ARCHITECTURE.md) · [native requirements](docs/PLATFORMS.md#linux-requirements) · [actual signed-package report](docs/verification/published-source77.json).

Model/runtime installation requires explicit download and licence consent. Exact catalog pins check imported/downloaded bytes. Review each model's terms. The Windows runtime prerequisite is the checked system Visual C++ Redistributable; it is not bundled with the worker. [Model pins and consent](docs/MODELS.md).

## Resource controls and updates

Local policy controls CPU threads, memory, operating windows, battery pauses and temperature limits where telemetry is available. Drain stops taking new work; immediate stop requests shutdown. Windows CPU uses a hard Job Object memory limit. Windows CUDA adds an independent sampled GPU memory watchdog, not a hard VRAM reservation or hardware fault partition. Linux requires finite memory/CPU/task limits and zero swap. [Controls](docs/OPERATIONS.md#local-controls) · [measured limits](docs/PLATFORMS.md).

The anonymous project Minisign signature authenticates the release manifest and its archive hashes. The installers/updater validate source identity, bounded safe extraction and highest accepted release sequence, rejecting tampering and downgrades. Windows manual signed updates are supported; automatic installation remains disabled. Linux automatic updating is opt-in under the supervised service. [Verify downloads](docs/VERIFICATION.md#verify-your-download) · [update/recovery evidence](docs/VERIFICATION.md#updates-and-recovery).

## Trust limits

Windows executables have **no trusted Authenticode publisher signature**. Minisign establishes possession of the trusted project key, not a legally verified publisher, security audit or guaranteed safety. [Windows warning guidance](docs/INSTALLATION.md#windows-publisher-warnings).

The owning user, host operating system, drivers and pinned external inputs are trusted. Per-user installation/state are not protected against their owner. A device signature identifies its key; it does not attest honest execution, model identity or hardware. Boundary fixtures do not establish compatibility with every host or independent certification. Linux native builds are not hermetic. [Reproducibility scope](docs/BUILD.md#reproducibility-and-release-status).

Published 0.1.0 CUDA evidence covers only the recorded Windows RTX 3070 Ti/driver/Qwen3-4B configuration; that Linux release refuses GPU execution. Source 0.2.0 contains a development Linux CUDA profile pending actual hardware and signed-package gates, as described in [platform status](docs/PLATFORMS.md#linux-requirements). Its GPU watchdog samples whole-device NVML memory and trusts the shared driver; it is not a hard VRAM cap or hardware fault partition. The pinned candidate image server requires a random bearer credential and accepts only model discovery and bounded image generation routes. Older unauthenticated image routes remain refused. The specialised immutable model inspection distinguishes tokenizer vocabulary and required licence attribution from personal metadata; it does not weaken source/history/package privacy checks. Use only the documented trusted pinned workload and supported configurations.
