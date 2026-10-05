<img src="docs/assets/excess-mark.png" alt="Excess" width="96" />

# Excess Worker

Run selected models on your computer and supply inference capacity through [Excess](https://excess.sh). The worker pairs with a separately operated coordinator, applies your local policy, and signs device results. Wallet approvals stay in the website.

**Source preview.** No worker release has been published. The source build and CLI diagnostics work. A local Linux CPU job has passed through the read-only controller entry using a fixture coordinator, test-only PGlite database and synthetic ledger. That is local integration evidence; it does not verify real payments, a public coordinator, or a downloadable package. Linux controller kernel fixtures pass in Linux x64. Installation, automatic update, public release and GPU gates remain closed.

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

Linux boundary fixtures cover host-path and host-process isolation, direct-network denial, broker identity, cleanup and bounded resource configuration. Windows source supports the adapter's pinned AppContainer helper and CPU adapter path; it does not include a Node controller. Neither platform has a published installer or release. No GPU execution is verified.

## Develop

The standalone npm workspace contains `apps/worker`, `packages/adapters` and `packages/protocol`, with their tests and build tooling. Coordinator services, custody and settlement signing are maintained separately.

[Build and packaging](docs/BUILD.md) | [Architecture](docs/ARCHITECTURE.md) | [Contributing](CONTRIBUTING.md) | [Source history](docs/HISTORY.md)
