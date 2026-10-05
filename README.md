<img src="docs/assets/excess-mark.png" alt="Excess" width="96" />

# Excess Worker

Run selected models on your computer and supply inference capacity through [Excess](https://excess.sh). The worker pairs with a separately operated coordinator, applies your local policy, and signs device results. Wallet approvals stay in the website.

**Source preview.** No new release has been published. Source builds and CLI diagnostics work; useful CPU/GPU model execution inside the new isolation boundaries has not passed the release gates. Windows production launches and unverified GPU launches fail closed. See [platform status](docs/PLATFORMS.md).

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

The Linux CPU boundary uses Landlock, seccomp and kernel resource limits. The Windows AppContainer prototype is not integrated with the worker transport. Current execution restrictions and their limits are described in [platforms](docs/PLATFORMS.md) and [security](SECURITY.md).

## Develop

The standalone npm workspace contains `apps/worker`, `packages/adapters` and `packages/protocol`, with their tests and build tooling. Coordinator services, custody and settlement signing are maintained separately.

[Build and packaging](docs/BUILD.md) | [Architecture](docs/ARCHITECTURE.md) | [Contributing](CONTRIBUTING.md) | [Source history](docs/HISTORY.md)
