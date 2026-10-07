![Excess — idle capacity, real opportunity](docs/assets/excess-banner.png)

# Excess Worker

Run selected AI models on your computer and supply inference capacity through [Excess](https://excess.sh), with local controls over when and how your machine works.

**Excess Worker 0.1.0 · [Download for Windows x64](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/excess-worker-0.1.0-2980a6ec2e58-win-x64.zip) · [Download for Linux x64](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/excess-worker-0.1.0-2980a6ec2e58-linux-x64.tar.gz)**

**[Verify your download →](docs/VERIFICATION.md#verify-your-download)** Establish the project public key, verify the release signature, then check your archive before installing. [All release files](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) · [Installation guide](docs/INSTALLATION.md)

## Trust and machine protection

- **Public source.** Inspect the worker and build it yourself. [Source and build instructions](docs/BUILD.md).
- **Project-signed downloads.** Minisign authenticates the release manifest; its signed hashes identify the exact archives. [Key and verification commands](docs/VERIFICATION.md#verify-your-download).
- **Reproducible packages.** Windows and Linux archives matched across two clean builds from pinned inputs. This covers assembled packages, not independent rebuilds of upstream binaries, operating systems or drivers. [Build scope](docs/BUILD.md#reproducibility-and-release-status) · [comparison report](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/reproducibility.json).
- **Scoped machine credentials.** A revocable device key signs worker messages. It cannot authorize wallet spending or withdrawals, and the model runtime never receives it. [Credential handling](SECURITY.md#sensitive-local-data).
- **Restricted model access.** Selected model/runtime files are read-only, scratch is private, and direct network access is denied. Downloads require explicit model/runtime and licence consent. [Security boundaries](SECURITY.md#model-runtime-boundaries) · [model consent](docs/MODELS.md).
- **Control and authenticated updates.** Set resource limits, drain or stop work, and revoke a device. Signed updates reject tampering and older release sequences. [Supplier controls](docs/OPERATIONS.md#local-controls) · [update and recovery evidence](docs/VERIFICATION.md#updates-and-recovery).

A valid signature establishes that the release was signed by the holder of the trusted **project key**, and that its authenticated contents have not changed. It does not establish a verified legal publisher, an independent security audit or guaranteed safety. Windows executables have **no trusted Authenticode publisher signature**; read the [Windows warning guidance](docs/INSTALLATION.md#windows-publisher-warnings) before running them.

## Start supplying

1. **Download.** Choose the archive for your platform, plus `release.json` and `release.json.minisig` from the [0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0). Packages include Node; suppliers do not need npm or a source build.
2. **Verify.** Follow [Verify your download](docs/VERIFICATION.md#verify-your-download), including establishing the trusted key. The website's file checker compares hashes; it does **not** verify a release signature.
3. **Install.** Use the [verified offline installer commands](docs/INSTALLATION.md#install-the-verified-package) as your ordinary user. Add the installed launcher to your session's PATH, then run `excess-worker guide` and `excess-worker doctor`.
4. **Pair.** Run `excess-worker pair https://excess.sh "my-worker"`. Sign in on the [Supply page](https://excess.sh/supply), compare the displayed code and fingerprint, approve the device, then run `excess-worker complete-pairing`. Wallet approvals happen on the website.
5. **Choose a model.** Run `excess-worker models`, select `excess-worker use qwen3-4b --cpu`, then review `excess-worker model-plan`. Read the listed licences and download sizes before [accepting the model/runtime installation](docs/INSTALLATION.md#choose-and-install-a-model).
6. **Supply capacity.** Set your resource policy and supplier price, then start work: `excess-worker run` on Windows, or the bounded user service on Linux. [Exact commands and price units](docs/INSTALLATION.md#supply-capacity). Check progress and earnings on the Supply page. Availability does not guarantee demand or earnings.

## Models you can choose

The local catalogue has **13 text models and four media models**, with pinned files and licences.

| Task | Available catalogue entries |
| --- | --- |
| Text | Qwen3 4B, 8B, 14B, 30B-A3B, 32B, Coder 30B-A3B and Instruct 2507; Phi-4 mini and Phi-4; Llama 3.1 8B and Llama 3.3 70B; gpt-oss 20B and 120B. |
| Embeddings | Qwen3 Embedding 0.6B. |
| Transcription | Qwen3 ASR 0.6B. |
| Images | SD-Turbo and FLUX.1 schnell. |

**[Complete catalogue: sizes, memory, quantization, licences and installation steps](docs/MODEL-CATALOG.md)** Run `excess-worker models` to see every local entry and its estimated fit. Hosted-provider models on the website are a separate service and cannot be installed on a worker.

Catalogue availability is broader than verified execution. The configuration table below records the measured 0.1.0 release scope; it does not restrict catalogue visibility or promote untested entries to verified support.

## Your machine, your controls

Choose the model, price, CPU threads, memory budget and operating schedule. Battery pauses and temperature limits depend on available telemetry. Windows CUDA has a separate sampled GPU memory watchdog; it is not a hard VRAM reservation or hardware partition. Use `excess-worker drain` to finish the current attempt without taking new work, or `excess-worker stop-now` to request immediate shutdown. Revoke a device on the Supply page to remove its coordinator access. [Controls, stopping and revocation](docs/OPERATIONS.md).

| Configuration | Verified scope for 0.1.0 |
| --- | --- |
| Windows x64 CPU | Qwen3-4B on the recorded Windows 11 workstation. |
| Windows x64 NVIDIA CUDA | Qwen3-4B on RTX 3070 Ti, driver 596.49, with separate 6 GiB host and GPU budgets. |
| Linux x64 CPU | Qwen3-4B on WSL2 with the required bounded systemd user service. |
| Linux GPU | Unsupported; execution is refused. |

See [requirements and measured configurations](docs/PLATFORMS.md) before downloading a model. Fresh application installs and actual project-funded testnet buyer jobs verified these configurations; this does not establish compatibility with every operating system, model or GPU. [Release execution evidence](docs/VERIFICATION.md#current-evidence).

## For developers

The standalone npm workspace contains the worker, adapters and protocol. Coordinator services, custody and settlement signing are maintained separately.

Use Node **24.11.1**, npm **11.7.0** and the committed lockfile. Use `npm.cmd` in Windows PowerShell.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

[Build and packaging](docs/BUILD.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Source history](docs/HISTORY.md) · [MIT licence](LICENSE)

Found a security issue? Use [GitHub private vulnerability reporting](https://github.com/excesssh/Excess-Worker/security/advisories/new). Keep exploitable details out of public issues. [Security policy](SECURITY.md#reporting).
