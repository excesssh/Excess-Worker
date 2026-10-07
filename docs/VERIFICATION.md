# Release verification and evidence

No downloadable worker release is published. A project Minisign signature authenticates source/version/sequence and archive hashes. It does not certify honest inference, isolation, device-key custody or GPU hardware. [PLATFORMS.md](PLATFORMS.md) is the current support/evidence summary.

## Current evidence

The [exact source70 signed CPU report](verification/signed-cpu-source70.json) records fresh application installation on Windows and WSL Linux, live HTTPS pairing at testnet.excess.sh, a project-funded 27-token buyer job on each platform, device-signature validation, settled accounting, drain, restart, remote revocation and cleanup. The coordinator/database/ledger were real testnet services. These were existing project-funded test accounts; no new deposit, withdrawal, mainnet action, organic demand, independent supplier or fresh operating system is claimed.

Actual offline signed installation/update and manual recovery passed. Recovery reverified the previous project signature, archive, every installed file and Linux executable modes, preserved sequence 11 high-water, ran previous-package inference and rolled forward. This is manual recovery evidence, not an automatic network updater or integrated rollback-command claim.

The [Windows CUDA report](verification/windows-cuda-development.json) records real GPU development inference on RTX 3070 Ti / driver 596.49 with two independent 6 GiB budgets,37/37 observed layers, correct output, cancellation, restart and cleanup. The newest native helper and source hashes are included. The exact signed GPU installation/funded buyer/drain/revoke journey and controlled HTTPS signed updates remain pending. Neither fixture tests nor inventory/health probes complete these gates.

Build-time `publicDistributionReady`, controller and execution readiness flags remain closed. They must change only against corresponding source/artifact-bound evidence. No public binary or production download/update feed has been verified.

## Verify a signature and archive

Establish [minisign.pub](../releases/minisign.pub) from a trusted checkout. Downloading a key beside an untrusted archive does not establish independent trust.

```sh
minisign -Vm release.json -x release.json.minisig -p releases/minisign.pub
```

Compare the exact platform filename, byte count and SHA-256 with its authenticated entry in `release.json`. Require the intended source commit, increasing release sequence and supported platform. The updater additionally retains TLS/paired-origin authentication, archive/path/file validation, source identity and downgrade/high-water protections.

The local builder compares complete archives from two independent clean build directories before signing with the anonymous project key supplied through secure storage:

```sh
node scripts/public-worker/release.mjs <build-a/packages> <build-b/packages> <candidate-out>
```

Signing a closed candidate does not promote readiness. Windows executables have no trusted Authenticode publisher signature. Trusted publisher signing, paid certificates and identity verification are outside scope.

## Deliberate candidate installation

Default installers refuse closed candidates after verification and remove staging. For deliberate verification of the actual project-signed candidate, use a separate install root and `-VerificationCandidate` on Windows or `--verification-candidate` on Linux. These options preserve signature, identity, hashes, archive paths, high-water, native isolation and cleanup; they do not open public readiness or automatic updates. They do not execute a downloaded script.

```powershell
powershell -NoProfile -File scripts/worker-install/install.ps1 release.json release.json.minisig <exact-windows-archive> -VerificationCandidate
```

```sh
sh scripts/worker-install/install.sh release.json release.json.minisig <exact-linux-archive> --verification-candidate
```

Use [INSTALLATION.md](INSTALLATION.md) for the current installation scope. Windows host-owned signed update reporting permits only the captured paired origin and package state; the child cannot choose a URL, version override or installer command. Windows automatic installation remains disabled. Positive controlled HTTPS updating is required before publication.

## Historical evidence

Earlier [source64 CPU packages](verification/packaged-cpu-source64.json), [Linux integration](verification/linux-controller-cpu.json), prototype Windows reports and native/control fixtures remain unchanged historical reports. Their fixture HTTPS coordinators, ephemeral CAs and synthetic PGlite ledgers do not establish funded production/testnet journeys. Their closed flags and pending checks describe those exact older sources. They are superseded as current status by the source70 CPU report and latest narrowly scoped GPU development report above.

Kernel fixtures cover their named filesystem, credential, network, broker, process, resource and cleanup cases. CI does not set release readiness. The website file checker compares filename/size/SHA but does not verify Minisign in the browser; receipt checking verifies only signed fields for the supplied device key. Keep these claims distinct from release authentication and hardware proof.
