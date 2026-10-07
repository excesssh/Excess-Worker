# Release verification and evidence

[Release 0.1.0](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) publishes source77, signed sequence 18. A project Minisign signature authenticates source/version/sequence and archive hashes. It does not certify honest inference, isolation, device-key custody or GPU hardware. [PLATFORMS.md](PLATFORMS.md) is the current support/evidence summary.

## Current evidence

[Final source77 publication evidence](verification/published-source77.json) binds release 0.1.0, signed sequence 18, to fresh default installation and real funded testnet buyer inference on Windows CUDA, Windows CPU and WSL Linux CPU. Each produces the expected 27-token answer with a verified device signature and settled accounting, drains during the job, restarts with a fresh isolated probe and revokes/retires the device. Windows CUDA and CPU also pass authenticated live buyer cancellation and cleanup. CUDA observes37/37offloaded layers and independent host/GPU resource budgets on the exact configuration in [PLATFORMS.md](PLATFORMS.md).

These are fresh application directories on the recorded workstation, not fresh operating systems or independent suppliers. Existing project-funded credited testnet balances and actual coordinator/database/ledger services are used. No fixture engine, new deposit, withdrawal, mainnet job or organic demand is claimed. Reviewed operator reports are not independent hardware attestation.

Controlled HTTPS signed updates pass for16-to17and17-to18on both platforms: bad signatures, changed manifests/archives and authentic downgrades refuse without changing the launcher/high-water. Manual previous17rollback and real isolated inference preserve the full18high-water bytes; current18inference and authenticated roll-forward pass. Actual public production17-to18download/install succeeds with default TLS, default fetch and the pinned key. Complete 339/340file inventories, Linux executable modes and current production/testnet feeds are verified. Every published GitHub asset and feed file fetches with matching hashes.

`releases/execution-evidence.json` binds the tested candidate15payload to every executable, dependency, native pin, launcher and licence byte. Optional --release-ready builds require committed unchanged reports, tested-source ancestry and matching payload; default builds remain closed. The final exact source77 signed18package repeats actual execution/installation/update/recovery checks before publication. Metadata changes cannot supply execution evidence. Source74candidate15, source70 CPU and earlier development/controlled reports remain historical evidence for their exact sources.

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

Use [INSTALLATION.md](INSTALLATION.md) for the current installation scope. Windows host-owned signed update reporting permits only the captured paired origin and package state; the child cannot choose a URL, version override or installer command. Windows automatic installation remains disabled. Positive controlled HTTPS and public production updates are verified for the recorded release.

## Historical evidence

Earlier [source64 CPU packages](verification/packaged-cpu-source64.json), [Linux integration](verification/linux-controller-cpu.json), prototype Windows reports and native/control fixtures remain unchanged historical reports. Their fixture HTTPS coordinators, ephemeral CAs and synthetic PGlite ledgers do not establish funded production/testnet journeys. Their closed flags and pending checks describe those exact older sources. They are superseded as current status by the source74 exact signed-package report above.

Kernel fixtures cover their named filesystem, credential, network, broker, process, resource and cleanup cases. CI does not set release readiness. The website file checker compares filename/size/SHA but does not verify Minisign in the browser; receipt checking verifies only signed fields for the supplied device key. Keep these claims distinct from release authentication and hardware proof.
