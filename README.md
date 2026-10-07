<img src="docs/assets/excess-mark.png" alt="Excess" width="96" />

# Excess Worker

Run selected models on your computer and supply inference capacity through [Excess](https://excess.sh). The worker pairs with a separately operated coordinator, applies your local policy, and signs device results. Wallet approvals stay in the website.

**[Download Excess Worker 0.1.0](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0).** Anonymous Minisign-signed Windows x64 and Linux x64 packages are published at source77, sequence 18. Fresh application installs, pairing and funded testnet buyer inference pass on Windows CPU, Windows CUDA and WSL Linux CPU, with drain, restart, revoke and cleanup. Windows CUDA/CPU also pass live buyer cancellation. Signed HTTPS updates, tamper/downgrade refusal and real previous-package recovery pass on both platforms. [Current configuration evidence and limits](docs/PLATFORMS.md) remain specific to the measured machines.

[Installation](docs/INSTALLATION.md) | [Release verification](docs/VERIFICATION.md) | [Releases](https://github.com/excesssh/Excess-Worker/releases) | [MIT licence](LICENSE)

## Quick start

Use Node **24.11.1** and npm **11.7.0**. In Windows PowerShell use `npm.cmd` for these commands.

```sh
npm ci --ignore-scripts
npm run build
npm test
node apps/worker/dist/main.js doctor
node apps/worker/dist/main.js guide
```

Diagnostics report local inventory; they do not execute a model. A coordinator is required to pair and supply jobs. [Operation](docs/OPERATIONS.md) covers pairing, model consent, offers, draining and service management.

## Your machine, your controls

Pairing creates a scoped, revocable machine key. It cannot authorize wallet spending or withdrawals. Linux protects the key with file permissions; Windows uses current-user DPAPI. Local policy controls schedules, idle use, thermal limits, concurrency and resources. The model runtime receives its own API token and selected files, rather than the machine credential.

On Linux, a pinned native controller creates private user, mount, PID, network, IPC and UTS namespaces. It exposes the installed app and selected model/runtime directories read-only, gives scratch data a size-limited temporary filesystem, and closes direct network access. A separately supervised host broker authenticates the controller's Unix socket peer and permits only bounded routes to the paired HTTPS origin. The controller reads state through a read-only mount. A state broker mediates writes; the controller has no direct writable host state directory. The run also requires a dedicated bounded cgroup v2 user service. Details and limits are in [platform status](docs/PLATFORMS.md) and [security](SECURITY.md).

Linux and Windows boundary fixtures cover host files/processes, credentials, direct-network denial, authenticated brokers, cleanup and resource limits. Windows uses a pinned AppContainer controller, typed host broker and separate model sandbox. The host captures paired origin and signed package state for update reporting; the child cannot supply an installer operation or arbitrary URL. [Current signed-package evidence](docs/verification/signed-package-source74.json) uses the live testnet coordinator and its funded ledger. Earlier CPU and GPU reports remain historical evidence for their exact sources. Read [release verification](docs/VERIFICATION.md) before building or installing candidates.

## Develop

The standalone npm workspace contains `apps/worker`, `packages/adapters` and `packages/protocol`, with their tests and build tooling. Coordinator services, custody and settlement signing are maintained separately.

[Build and packaging](docs/BUILD.md) | [Architecture](docs/ARCHITECTURE.md) | [Contributing](CONTRIBUTING.md) | [Source history](docs/HISTORY.md)

Release signing uses the anonymous project Minisign key. Windows executables have no trusted Authenticode publisher signature. Trusted Windows publisher signing, paid certificates and identity verification are outside release scope. See [pinned model download/import](docs/MODELS.md).
