# Release verification and evidence

No downloadable worker release is published. A project Minisign signature authenticates source/version/sequence and archive hashes. It does not certify honest inference, isolation, device-key custody or GPU hardware. [PLATFORMS.md](PLATFORMS.md) is the current support/evidence summary.

## Current evidence

The [source74 signed-package report](verification/signed-package-source74.json) records actual anonymous project-Minisign-signed candidate15 installation and funded testnet buyer inference on Windows CUDA, Windows CPU and WSL Linux CPU. Each produces the expected27-token answer, verifies the device signature, settles accounting, drains during the job, restarts with a fresh isolated probe and revokes/retires the device. Windows CUDA and CPU also complete an additional authenticated live buyer cancellation followed by drain and cleanup. The CUDA run observes37/37offloaded layers and separate host/GPU resource budgets on the configuration in [PLATFORMS.md](PLATFORMS.md).

These are fresh application directories on this workstation, not fresh operating systems or independent suppliers. Existing project-funded credited testnet balances are used with real coordinator/database/ledger services. No new deposit, withdrawal, mainnet action or organic demand is claimed. The public summary binds the source, signed manifest, reviewed private report hashes and measured configuration; it is operator evidence, not independent hardware attestation.

Earlier offline update and manual recovery evidence remains valid for its exact packages: previous signature/archive/full inventory/executable modes were reverified, its high-water retained, previous-package inference and roll-forward passed. This does not complete the new positive network updater gate.

`releases/execution-evidence.json` binds every executable, dependency, native pin, launcher and licence byte from candidate15 to reviewed execution evidence. Optional `--release-ready` builds require this report committed unchanged, tested-source ancestry and matching payload. Closed candidates remain the default. Metadata/onboarding changes alone cannot supply runtime evidence. Ready candidates still require exact final signed installation/execution and controlled HTTPS update/rollback before publication. [Local eligible sequence16](verification/ready-source75.json) reproduces across independent complete Windows/Linux builds and verifies with the actual anonymous project key; its runtime payload matches tested candidate15. A distinct signed successor is required for the controlled HTTPS update rehearsal. No public binary or production signed feed is published yet.

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

Earlier [source64 CPU packages](verification/packaged-cpu-source64.json), [Linux integration](verification/linux-controller-cpu.json), prototype Windows reports and native/control fixtures remain unchanged historical reports. Their fixture HTTPS coordinators, ephemeral CAs and synthetic PGlite ledgers do not establish funded production/testnet journeys. Their closed flags and pending checks describe those exact older sources. They are superseded as current status by the source74 exact signed-package report above.

Kernel fixtures cover their named filesystem, credential, network, broker, process, resource and cleanup cases. CI does not set release readiness. The website file checker compares filename/size/SHA but does not verify Minisign in the browser; receipt checking verifies only signed fields for the supplied device key. Keep these claims distinct from release authentication and hardware proof.
