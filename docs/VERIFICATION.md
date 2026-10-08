# Verify an Excess Worker release

Excess Worker [0.1.0 is published](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0). Its anonymous project Minisign signature authenticates `release.json`, which contains the exact platform archive names, sizes and SHA-256 hashes. Verify the signature first, then the archive. A matching hash alone does not authenticate the publisher.

## Verify your download

### 1. Establish the trusted project key

Confirm you are using **`excesssh/Excess-Worker`**, reached through a project location you already trust, such as an independently opened [excess.sh](https://excess.sh). Review [the key in the tagged source](https://github.com/excesssh/Excess-Worker/blob/v0.1.0/releases/minisign.pub), and compare it with a trusted checkout or a previously saved trusted copy when available. The full public key for 0.1.0 is:

```text
RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
```

On first use, trusting the project website/repository over HTTPS is your trust decision. A key fetched beside an untrusted archive does not independently prove who published it. Preserve the established key for later releases; investigate a key change rather than accepting it from a download message. This is a pseudonymous project key, not a certificate of a person's legal identity.

Install [Minisign from its official project](https://jedisct1.github.io/minisign/) and make the command available on PATH. Download your platform archive, [release.json](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/release.json) and [release.json.minisig](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/release.json.minisig) into the same directory.

### 2. Authenticate the manifest

From that directory, this command works in PowerShell and a Linux shell:

```sh
minisign -Vm release.json -x release.json.minisig -P RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
```

Require a successful exit and Minisign's signature/trusted-comment verification message. If verification fails, stop. Do not proceed using hashes from an unauthenticated manifest.

The signature establishes that the manifest was signed by the holder of the trusted project key and has not changed. It does not certify safe behavior, honest inference, GPU compatibility, an independent audit or a Windows-trusted publisher.

### 3. Check the archive against the authenticated manifest

For 0.1.0, the authenticated identity is version `0.1.0`, source commit `2980a6ec2e580251208b3b31d81d3fec6e4b4567`, release sequence `18`, repository `https://github.com/excesssh/Excess-Worker`.

**Windows PowerShell**, after the successful signature check:

```powershell
$release = Get-Content -LiteralPath .\release.json -Raw | ConvertFrom-Json
if ($release.product -cne 'Excess Worker' -or $release.repository -cne 'https://github.com/excesssh/Excess-Worker' -or $release.version -cne '0.1.0' -or $release.sequence -ne 18 -or $release.sourceCommit -cne '2980a6ec2e580251208b3b31d81d3fec6e4b4567') { throw 'Unexpected release identity' }
$archive = '.\excess-worker-0.1.0-2980a6ec2e58-win-x64.zip'
$entry = @($release.files | Where-Object { $_.platform -ceq 'win32-x64' })
if ($entry.Count -ne 1 -or $entry[0].file -cne (Split-Path $archive -Leaf) -or $entry[0].bytes -ne (Get-Item -LiteralPath $archive).Length -or $entry[0].sha256 -cne (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Archive verification failed' }
'Verified Windows archive against the signed manifest'
```

**Linux**, after the successful signature check:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
release = json.loads(Path('release.json').read_text())
if (release['product'], release['repository'], release['version'], release['sequence'], release['sourceCommit']) != ('Excess Worker', 'https://github.com/excesssh/Excess-Worker', '0.1.0', 18, '2980a6ec2e580251208b3b31d81d3fec6e4b4567'):
    raise SystemExit('Unexpected release identity')
archive = Path('excess-worker-0.1.0-2980a6ec2e58-linux-x64.tar.gz')
entries = [entry for entry in release['files'] if entry['platform'] == 'linux-x64']
if len(entries) != 1:
    raise SystemExit('Unexpected platform entries')
entry = entries[0]
if archive.name != entry['file'] or archive.stat().st_size != entry['bytes'] or hashlib.sha256(archive.read_bytes()).hexdigest() != entry['sha256']:
    raise SystemExit('Archive verification failed')
print('Verified Linux archive against the signed manifest')
PY
```

Only after both checks pass, follow [the offline installation guide](INSTALLATION.md#install-the-verified-package). The installers independently repeat signature and integrity verification and enforce source identity, safe paths and release-sequence checks.

The [website file checker](https://excess.sh/verify) compares a file's name, size and hash. It does **not** verify Minisign in the browser. A receipt checker verifies signed fields for a device key; that is a different signature and does not authenticate a release or prove honest execution.

## Current evidence

[Published release evidence](verification/published-source77.json) binds the exact 0.1.0 package to fresh application installation and actual project-funded testnet buyer inference on Windows CPU, Windows CUDA and WSL2 Linux CPU. Each produced the expected 27-token answer, verified its device-signed receipt and accounting, drained during work, restarted with a fresh isolated probe, and revoked/retired the device. Windows CPU/CUDA also passed live buyer cancellation and cleanup. [Measured configurations and limits](PLATFORMS.md).

These are fresh application directories on the recorded workstation, not fresh operating systems or independent suppliers. Existing project-funded credited testnet balances and actual coordinator/database/ledger services were used. No fixture engine, new deposit, withdrawal, mainnet job or organic demand is claimed. Operator reports are not independent hardware attestation.

Complete assembled Windows and Linux archives reproduced byte-for-byte in two clean build directories. See [build scope](BUILD.md#reproducibility-and-release-status) and the [release comparison report](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/reproducibility.json). That immutable report was generated before the final installation/publication checks and retains its then-pending publication wording; the final linked publication evidence records their completion. Upstream Node/model/runtime binaries and OS/driver/toolchain dependencies were not independently rebuilt.

**Unpublished Windows candidate evidence.** Sequence 24, source `7a33c1b51a12fea87601e3d81d5a9b1b114588d6`, passed eight actual packaged-worker testnet buyer routes: Qwen3-4B text, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and SD-Turbo images, each on CPU and CUDA. These results apply only to the recorded Windows workstation. The first CUDA image attempt expired before delivery began; a same-source retry passed, but its cause remains unresolved. This does not change 0.1.0 support or downloads. [Candidate coverage and limits](windows-media-candidate-coverage.md). [Source-bound candidate evidence](verification/windows-source90.json).

## Updates and recovery

The [final public update report](verification/published-source77.json) records actual production HTTPS download/install from signed sequence 17 to 18 on Windows and Linux with default TLS, fetch and the pinned key. Complete 339/340-file inventories and Linux executable modes matched. All six GitHub release assets and all feed files publicly downloaded with matching hashes.

[Controlled HTTPS checks](verification/https-update-source76.json) and final release checks record rejected bad signatures, changed manifests/archives and authentic downgrades without changing the launcher or highest accepted release state. Manual recovery to the previous signed package, real isolated inference and authenticated roll-forward preserved the full sequence-18 high-water state. This is tested manual recovery, not an automatic rollback feature.

Use `excess-worker update --check` after pairing. Manual updates retain paired-origin HTTPS authentication, the pinned signature key, archive/file checks and downgrade protection. Windows automatic installation is disabled; Linux automatic updating is opt-in under its supervised service. [Update operation](INSTALLATION.md#stop-revoke-and-update).

## Technical release evidence

The immutable tag points to source commit `2980a6ec2e580251208b3b31d81d3fec6e4b4567` (curated source 77), signed sequence 18. Later documentation commits do not alter that source tag or the signed assets.

`releases/execution-evidence.json` binds the tested source-74 candidate-15 payload to executable, dependency, native pin, launcher and licence bytes. Optional `--release-ready` builds require committed unchanged reports, tested-source ancestry and matching payload; default development packages remain closed. Final source-77 sequence-18 packages repeated actual installation, execution, update and recovery checks before publication. Metadata changes cannot supply execution evidence.

For local signing after two complete clean builds:

```sh
node scripts/public-worker/release.mjs <build-a/packages> <build-b/packages> <candidate-out>
```

Signing a closed development candidate does not open readiness. Deliberate testing uses `-VerificationCandidate` on the Windows installer or `--verification-candidate` on Linux, in a separate install root. These options retain signature, identity, integrity, high-water, native boundary and cleanup checks. They are unnecessary for the published 0.1.0 release.

## Historical evidence

Earlier [source-64 CPU packages](verification/packaged-cpu-source64.json), [Linux integration](verification/linux-controller-cpu.json), [source-74 signed journeys](verification/signed-package-source74.json), prototype Windows reports and boundary fixtures remain historical evidence for their exact sources. Fixture HTTPS coordinators, ephemeral CAs and synthetic PGlite ledgers do not establish actual funded buyer journeys. Their closed flags and pending checks describe those older sources, superseded as current status by the final publication report.

Kernel fixtures cover their named filesystem, credential, network, broker, process, resource and cleanup cases. CI does not establish real model execution or set release readiness. Windows executables have no trusted Authenticode publisher signature. Release authentication uses the anonymous project Minisign key.
