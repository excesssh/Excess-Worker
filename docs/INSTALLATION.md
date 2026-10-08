# Install Excess Worker 0.2.0 (release sequence 26)

The published [0.2.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.2.0) contains signed Windows x64 and Linux x64 archives with Node included. You will not need npm to install them. Models and inference runtimes are separate downloads. The published [0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) remains available as an earlier, separate release. Check [supported configurations](PLATFORMS.md) before choosing a model or backend.

## Sequence-26 package identity

Use these sequence-26 archive names and tag-specific installer links for this release. The signed manifest records these exact names, hashes, source and sequence; verify it before running an installer.

```text
Windows archive: excess-worker-0.2.0-8724162f793d-win-x64.zip
Linux archive:   excess-worker-0.2.0-8724162f793d-linux-x64.tar.gz
Source tag:      v0.2.0
Expected source: 8724162f793d3ec009eb2f64f713a05c29857bd7
Sequence:        26
```

The project Minisign key is unchanged from v0.1.0; its sequence-26 tagged source and both installer copies were checked against the same key. Fresh direct Linux and Windows installations passed. The Windows install report verified all 340 files, the expected ready launcher, actual Minisign verification and high-water 26. Preserve the model/runtime and licence consent, user-level controls, drain, revoke, update and recovery guidance below.

## Download and verify first

Save your platform archive, `release.json` and `release.json.minisig` together in a new directory. Follow [Verify your download](VERIFICATION.md#verify-your-download) **before extracting or executing the package**. You will establish the project public key, authenticate the manifest and check the archive's exact name, byte count and SHA-256.

Install [Minisign from its official project](https://jedisct1.github.io/minisign/) and put it on PATH. Linux installation also needs Python 3. Windows uses Windows PowerShell 5.1. Download and inspect the appropriate offline installer from the trusted tagged source:

- Windows: [install.ps1 at the v0.2.0 release tag](https://raw.githubusercontent.com/excesssh/Excess-Worker/v0.2.0/scripts/worker-install/install.ps1), saved as `install.ps1`.
- Linux: [install.sh at the v0.2.0 release tag](https://raw.githubusercontent.com/excesssh/Excess-Worker/v0.2.0/scripts/worker-install/install.sh), saved as `install.sh`.

These scripts are obtained through the trusted source repository; they are not separately Minisign-signed release assets. Inspect them before running. They embed the same project key and repeat signature, archive integrity, safe extraction, source identity and downgrade checks. They read local release files and do not fetch or execute a remote installation script.

## Install the verified package

Run from the directory holding the four downloaded files, as the installing user. The installers refuse Administrator/root execution.

### Windows x64

```powershell
powershell.exe -NoProfile -File .\install.ps1 .\release.json .\release.json.minisig .\excess-worker-0.2.0-8724162f793d-win-x64.zip
$env:PATH = (Join-Path $env:LOCALAPPDATA 'EXCESS\bin') + ';' + $env:PATH
excess-worker guide
excess-worker doctor
```

The default installation is under `%LOCALAPPDATA%\EXCESS`; the managed launcher is `bin\excess-worker.cmd`. The PATH command affects this PowerShell session. You can add that bin directory to your **user** PATH for future sessions.

If PowerShell blocks the downloaded script, verify it came from the tagged project source and inspect its contents. After that review, `Unblock-File -LiteralPath .\install.ps1` removes its downloaded-file marker. If an organisation policy still blocks it, use your organisation's approved process. Do not change the machine execution policy or disable security controls.

### Linux x64

```sh
mkdir -p "${EXCESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/excess}"
sh ./install.sh ./release.json ./release.json.minisig ./excess-worker-0.2.0-8724162f793d-linux-x64.tar.gz
export PATH="${EXCESS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/excess}/bin:$PATH"
excess-worker guide
excess-worker doctor
```

The default installation is under `${XDG_DATA_HOME:-$HOME/.local/share}/excess`. An explicit `--prefix` must be an absolute directory writable by your user; set `EXCESS_INSTALL_ROOT` to that same prefix before later launcher/service commands. Do not use `sudo` for the worker installer.

Execution requires systemd with a usable user session, cgroup v2 limits, user/network namespaces, Landlock ABI 6 or newer and seccomp. Missing protections refuse execution. The existing real execution evidence is WSL2 CPU, not every Linux distribution. See [Linux requirements](PLATFORMS.md#linux-requirements).

`doctor` reports inventory and prerequisites; it does not execute a model or establish that capacity is live.

## Windows publisher warnings

Excess uses an anonymous project Minisign key. The Windows executables have **no trusted Authenticode publisher signature**. Windows may show an unknown-publisher or SmartScreen reputation warning even when the project signature verifies. Minisign does not remove that warning or establish a Windows-trusted publisher identity.

Before deciding to run, confirm the repository and key, the valid manifest signature and the matching archive checks. Inspect the named file in the warning. You may choose to proceed only if you trust the source and your policy allows it; cancel if you are unsure. Do not disable SmartScreen, Defender or organisation controls, and treat a malware detection as a reason to stop and investigate. [Microsoft's SmartScreen guidance](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/) explains the reputation check.

## Pair your machine

```sh
excess-worker pair https://excess.sh "my-worker"
```

Open [Excess Supply](https://excess.sh/supply) and sign in. Choose **Add a machine**, then **Next: pair your machine**. Enter the code shown by the CLI and compare the device fingerprint. Approve only when both match, then return to the CLI and run:

```sh
excess-worker complete-pairing
```

The label is your choice; avoid putting a personal name in it. Pairing creates a revocable worker credential. It cannot approve wallet spending or withdrawals. Testnet users must pair with `https://testnet.excess.sh` and approve in that same environment. [Credential details](../SECURITY.md#sensitive-local-data).

## Choose and install a model

Choose a model and inspect its estimate and pinned downloads. Candidate25 has actual Windows CPU/CUDA buyer evidence for Qwen3-4B, Embedding 0.6B, ASR 0.6B and SD-Turbo. The signed sequence25 WSL2 Linux Qwen3-4B CPU buyer job passed under the limits listed in PLATFORMS.md; sequence26 Linux direct installation/update and Windows direct installation/update passed. Sequence26 CPU and CUDA recovery probes also passed on Windows. Buyer execution remains attributed to sequence25, whose payload fingerprints match the released sequence26 packages. Published 0.1.0 evidence applies only to that earlier package.

```sh
excess-worker models
excess-worker use qwen3-4b --cpu
excess-worker model-plan
```

Review the displayed model/runtime plan, licences, disk space and hardware requirements. Only after accepting both downloads and licences, run:

```sh
excess-worker install-model qwen3-4b --accept-download --accept-licenses
```

The model/runtime installer uses pinned files and verifies size and hashes. Qwen3-4B's model alone is about 2.5 GB; budget additional room for runtime files and staging. On Windows the native runtime requires the pinned system Visual C++ Redistributable prerequisite checked by the model installer; it is not bundled with the worker. See [model pins and import](MODELS.md) and [the measured Windows CUDA policy](PLATFORMS.md#windows-cuda-policy) before choosing GPU execution. Catalog fit estimates do not establish execution support.

## Supply capacity

Review `excess-worker policy` and apply your chosen resource policy before starting. For the previously measured Windows CPU configuration, save this as `policy.json`. This setting is an example, not a support claim for an unverified model or machine:

```json
{"model":"qwen3-4b","backend":"cpu","threads":2,"maxMemoryMb":4096,"runSeconds":180}
```

```sh
excess-worker policy policy.json
excess-worker offer
```

Set a price in an asset listed by your paired exchange:

```text
excess-worker offer <SYMBOL> <your-price>
```

Replace the placeholders. For text models, a symbol price is your **net amount per million output tokens**, before the exchange adds its buyer fee. For example, `excess-worker offer USDG 1` sets 1 USDG per million output tokens where USDG is available. An asset UUID instead takes base units per metering unit; do not confuse these formats. Check the saved offer with `excess-worker offer`. [Price controls](OPERATIONS.md#pairing-and-offers).

On Windows, run in the foreground:

```sh
excess-worker run
```

On Linux, execution must run in the dedicated bounded systemd user service. For the published 0.1.0 measured 8 GiB/64-task configuration, create a service override **before** installing/starting it:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/excess-worker.service.d"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/excess-worker.service.d/resources.conf" <<'EOF'
[Service]
MemoryMax=8G
MemorySwapMax=0
TasksMax=64
CPUQuota=200%
EOF
excess-worker service install
excess-worker service status
```

Use this budget only if your machine has sufficient free memory; the published 0.1.0 test used it alongside a two-thread CPU policy. A signed sequence25 Linux CPU buyer job, a sequence26 fresh direct Linux installation and a sequence26 recovery CPU probe passed in their recorded scopes. Review `systemctl --user cat excess-worker.service` to see the effective unit. `service install` enables and starts the service immediately. It does not enable lingering automatically. Check `journalctl --user -u excess-worker.service` locally, keeping state paths and credentials private. Do not run a second foreground worker beside the service or remove required limits to bypass a refusal.

Use `excess-worker status` and the Supply page to inspect activity. Local offers become eligible through successful runtime probes and coordinator checks; they do not guarantee buyer demand or earnings.

## Stop, revoke and update

`excess-worker drain` stops accepting new work and lets the current attempt finish. `excess-worker stop-now` requests immediate shutdown. On Linux, `systemctl --user restart excess-worker.service` resumes the service; `excess-worker service remove` stops and removes its service configuration. On Windows, restart with `excess-worker run` after it exits.

Revoke the device on the Supply page to remove coordinator access. After outstanding work is handled, `excess-worker unpair` retires the local identity. Keep the state directory private and never include it in an issue or vulnerability report.

Use `excess-worker update --check` to inspect signed update availability. Drain and wait for exit before a manual `excess-worker update`, then restart. Windows automatic installation is disabled. Linux automatic updates are optional through `excess-worker update --auto on` in the supervised service. The signed sequence26 Linux update/recovery and Windows default-fetch update/tamper/downgrade/rollback/roll-forward checks passed. Fresh direct Windows installation passed with full inventory and launcher checks. Separate Windows CPU and CUDA recovery probes passed on sequences18 and 26; the CUDA probe offloaded 37 Qwen3-4B layers and preserved high-water 26. [Update authentication and recovery](VERIFICATION.md#updates-and-recovery).

For source builds, local packaging and candidate verification, use [BUILD.md](BUILD.md) and [VERIFICATION.md](VERIFICATION.md#technical-release-evidence); these are developer workflows.
