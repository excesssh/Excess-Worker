# Verify Excess Worker 0.2.0

The published [0.2.0 release, sequence 26](https://github.com/excesssh/Excess-Worker/releases/tag/v0.2.0) has a signed `release.json` with exact platform archive names, sizes, SHA-256 hashes, source identity and sequence. The detached signature was verified with the bundled verifier and Minisign 0.12. Establish the project key and verify the manifest before using its archive hashes. A matching hash alone does not authenticate a publisher.

## Verify your download

### 1. Establish the trusted project key

Confirm that you are using **`excesssh/Excess-Worker`**, reached through a project location you already trust, such as an independently opened [excess.sh](https://excess.sh). Review the public key in the tagged source at [releases/minisign.pub](https://github.com/excesssh/Excess-Worker/blob/v0.2.0/releases/minisign.pub). The v0.2.0 public key SHA-256 is `c14b80a70fd127519eb7185f4fbc4cdd5c0daf26cb522148bfb21eccab188cc6`, matching the embedded key in both platform installers. Compare it with a trusted checkout or a previously saved trusted copy before trusting the signature. The published [0.1.0 key and release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) remain available for historical comparison. Investigate any key change rather than accepting a key delivered beside an untrusted archive.

Install [Minisign from its official project](https://jedisct1.github.io/minisign/) and make the command available on PATH. Download the Windows or Linux archive, `release.json`, and `release.json.minisig` from the [0.2.0 release page](https://github.com/excesssh/Excess-Worker/releases/tag/v0.2.0) into the same directory.

### 2. Authenticate the release manifest

After confirming the final tagged key, run:

```sh
minisign -Vm release.json -x release.json.minisig -P RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
```

Require a successful exit and Minisign's signature/trusted-comment verification message. If verification fails, stop. Do not use hashes from an unauthenticated manifest. The signature authenticates the manifest under the trusted project key; it does not certify safe behavior, honest inference, GPU compatibility, an independent audit or a Windows-trusted publisher.

### 3. Check the selected archive against the signed manifest

The signed manifest identifies product `Excess Worker`, repository `https://github.com/excesssh/Excess-Worker`, version `0.2.0`, release sequence `26` and source `8724162f793d3ec009eb2f64f713a05c29857bd7`. It records Windows archive `excess-worker-0.2.0-8724162f793d-win-x64.zip` (SHA-256 `905dd300c6922ffe28b4a83bbbf299a4000aa22b6d61cd3f944a4f2acab16173`) and Linux archive `excess-worker-0.2.0-8724162f793d-linux-x64.tar.gz` (SHA-256 `446a98d1fb14fcc568c8a8856ff5e59fd1c2e1d19a4cdb58021134c5dcb3c268`).

**Windows PowerShell**, after the successful signature check:

```powershell
$release = Get-Content -LiteralPath .\release.json -Raw | ConvertFrom-Json
if ($release.product -cne 'Excess Worker' -or $release.repository -cne 'https://github.com/excesssh/Excess-Worker' -or $release.version -cne '0.2.0' -or $release.sequence -ne 26 -or $release.sourceCommit -cne '8724162f793d3ec009eb2f64f713a05c29857bd7') { throw 'Unexpected release identity' }
$archive = '.\excess-worker-0.2.0-8724162f793d-win-x64.zip'
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
if (release['product'], release['repository'], release['version'], release['sequence'], release['sourceCommit']) != ('Excess Worker', 'https://github.com/excesssh/Excess-Worker', '0.2.0', 26, '8724162f793d3ec009eb2f64f713a05c29857bd7'):
    raise SystemExit('Unexpected release identity')
archive = Path('excess-worker-0.2.0-8724162f793d-linux-x64.tar.gz')
entries = [entry for entry in release['files'] if entry['platform'] == 'linux-x64']
if len(entries) != 1:
    raise SystemExit('Unexpected platform entries')
entry = entries[0]
if archive.name != entry['file'] or archive.stat().st_size != entry['bytes'] or hashlib.sha256(archive.read_bytes()).hexdigest() != entry['sha256']:
    raise SystemExit('Archive verification failed')
print('Verified Linux archive against the signed manifest')
PY
```

Only after signature and archive checks pass, follow the [offline installation guide](INSTALLATION.md). The installers repeat signature, integrity, source-identity, safe-path and release-sequence checks.

The [website file checker](https://excess.sh/verify) compares a file's name, size and hash. It does **not** verify Minisign in the browser. A receipt checker verifies signed device fields; that signature is separate and does not authenticate a software release or prove honest execution.

## Candidate25 execution evidence

Candidate25 source `f07ffd9c6c447ed8f60fd258807a0f7d487796b4`, sequence 25, Windows archive SHA-256 `34d3febd9c64a1fe968101cfa6932d8a6dd33e50cbdffd7dcf1090195536ebd6` passed eight actual packaged-worker buyer routes on the recorded Windows workstation: Qwen3-4B text, Qwen3 Embedding 0.6B, Qwen3 ASR 0.6B and SD-Turbo images, each on CPU and CUDA. The candidate-only report records all eight route success, cancellation, drain, restart where required, and shared cleanup gates passed (report SHA-256 `c7efe17c97de538a6fa0df9c62f39c08f6a2e4671a11a59c479971d98ec4c84a`).

Five additional serial SD-Turbo CUDA buyer jobs on the same package returned signed artifacts and accounting. The separate API audit records all five authoritative job states as `succeeded`. The append-only buffered-media reconciliation (SHA-256 `25b5b3d1c5e320b7d59ab33cda9a330117ddb4c1c14d975ed1f795e38b95f6c3`) ties each job to host proof, the complete local `seen → running → result_pending → finished` chain, artifact, signed receipt, terminal accounting, supplier earnings and the observed lease. The original repeat-run report remains failed/incomplete with its observer reasons; the overlay preserves them. The API `deliveryStarted=false` flag is stream-specific and is not evidence that buffered image delivery failed.

The original candidate24 SD-Turbo CUDA failure's cause remains unestablished. A bounded native fixture reproduced an admission-ordering regression and verified its fix with targeted controls. That separate implementation finding does not establish the cause of the earlier buyer-job failure.

Candidate25 buyer reports identify sequence25 packages. The sequence26 build report matches executable, native, dependency, launcher and licence payload fingerprints against prepared sequence25 execution evidence for both platforms (SHA-256 `24ff8dbcbfbd6b2454c68b87c3facc615af3a98d70bd089487efbfb7cf743ff4`). A Linux Qwen3-4B CPU buyer job passed on the signed sequence25 package under WSL2 Linux 6.18.40.1 with 2 threads and cgroup limits of 8 GiB memory, zero swap, 64 tasks and CPU 200% (SHA-256 `69ad5c07769137a361122a3fd461f1c29adfbc09c2980da02c89152ffc4843ef`). The signed sequence26 Linux update/recovery report passed 12 checks, including a sequence26 CPU probe and recovery to sequence18 and back (SHA-256 `4a309c1c7370bb2b719d8754f2cc9020e5f5285d521886549540f7638206df1a`). Linux direct signed installation passed with 343 files hashed, executable modes checked, high-water 26 and zero owned runtime processes (SHA-256 `74fdfd8eda85e4e6a39e59b25961aa12bb984efd385b8274d6d5cf3025da218b`). Windows default-fetch HTTPS update passed 11 checks for invalid signature/manifest/archive refusal, authenticated upgrade, downgrade refusal, rollback and roll-forward; both package inventories were fully hashed (339 and 340 files), high-water 26 (SHA-256 `2793d6a3b5a62b86b42c4909d83d09d0ba7c69a30b0dacee5ef10444c1eb42e1`). Fresh direct sequence26 Windows installation passed with 340 files fully hashed, high-water 26, actual Minisign verification and the expected ready launcher (SHA-256 `90332df782245a29ab8f7bd66fb9ba49cfefbd2be6fe99033effd993c9926559`). Separate isolated Windows CPU and CUDA recovery probes passed on sequences18 and 26; CUDA offloaded 37 Qwen3-4B Q4_K_M layers while preserving high-water 26. These are runtime probes, not buyer jobs (CPU SHA-256 `4ec5fb249d8cb7ac0de44a5c4a42e7484e085b11b3c2a4f6c0a81ecf1caab62c`; CUDA SHA-256 `26c9c7b109e295759260cef8b511114fa367b292767f89a1c0ad1ff17190b7b7`). The local cleanup audit confirmed zero owned Linux/Windows runtime processes and released ports (SHA-256 `9934e5b5ae67a7a9f685735d10ec364c903462f92bcacd037773a73d2d539a32`). Windows buyer jobs remain identified as sequence25; sequence26 payload equivalence and lifecycle gates are separate evidence. Linux CUDA remains candidate-unverified, with no GPU support claim. Twelve other text entries have no Windows buyer execution evidence. FLUX.1 schnell has a 12 GiB VRAM estimate, above the recorded 8 GiB GPU; do not claim fit or support on that configuration. See the [remaining-work checklist](verification/remaining-work-checklist.md), [platform limits](PLATFORMS.md), [the local model catalogue](MODEL-CATALOG.md), and [Windows coverage](windows-media-candidate-coverage.md).

## Historical published 0.1.0 release

The published [0.1.0 release](https://github.com/excesssh/Excess-Worker/releases/tag/v0.1.0) and its anonymous project key remain unchanged. Its tagged public key is available at [releases/minisign.pub](https://github.com/excesssh/Excess-Worker/blob/v0.1.0/releases/minisign.pub); its manifest and detached signature are [release.json](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/release.json) and [release.json.minisig](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/release.json.minisig). The established public key was:

```text
RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
```

The historical identity was version `0.1.0`, source `2980a6ec2e580251208b3b31d81d3fec6e4b4567`, sequence 18. Its published evidence binds that exact package to actual project-funded testnet inference on Windows CPU, Windows CUDA and WSL2 Linux CPU. Those outcomes do not verify the 0.2.0 candidate or final sequence-26 package. See [published-source77 evidence](verification/published-source77.json), the [0.1.0 reproducibility report](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/reproducibility.json), and [historical measured configurations](PLATFORMS.md).

Windows executables have **no trusted Authenticode publisher signature**. Minisign is the anonymous project release signature; it does not establish a person's legal identity or a Windows-trusted publisher.

## Updates and recovery

Published 0.1.0 passed signed HTTPS updates, tamper/downgrade refusal and manual recovery to the previous signed package on Windows and Linux. This is historical evidence for that exact payload. The signed sequence26 Linux update/recovery run passed its 12 recorded checks, including tamper refusal, authenticated upgrade, a CPU probe, downgrade refusal, rollback to sequence18 and roll-forward to sequence26. The Windows signed default-fetch updater passed its 11 checks, including tamper refusal, authenticated upgrade, downgrade refusal and rollback/roll-forward. Fresh direct Windows installation passed with complete inventory and launcher checks. Separate Windows CPU and CUDA runtime recovery probes passed on sequences18 and 26; they are not buyer jobs. Windows automatic installation is disabled; Linux automatic updating is opt-in under its supervised service. See [installation and update operation](INSTALLATION.md#stop-revoke-and-update).

The immutable 0.1.0 tag points to source `2980a6ec2e580251208b3b31d81d3fec6e4b4567` (curated source 77), signed sequence 18. Historical [technical release evidence](#technical-release-evidence) binds its tested payload and named isolation gates. See the [published installation and execution report](verification/published-source77.json), the [earlier authenticated-update checks](verification/https-update-source76.json), and the [0.1.0 reproducibility report](https://github.com/excesssh/Excess-Worker/releases/download/v0.1.0/reproducibility.json). Later documentation does not alter that tag or its assets. Earlier source and fixture reports remain historical and do not establish model execution or readiness for 0.2.0.

## Technical release evidence

The current [execution evidence](../releases/execution-evidence.json) binds the signed candidate25 payload to actual Windows CPU/CUDA and Linux CPU buyer execution. The [final successor report](verification/source92-neutral.json) records sequence26 signature, installation, update, rollback, roll-forward and recovery checks and unchanged execution payloads. Linux GPU remains candidate-unverified.

The historical [0.1.0 execution evidence](https://github.com/excesssh/Excess-Worker/blob/v0.1.0/releases/execution-evidence.json) binds the tested source-74 candidate-15 payload to executable, dependency, native-pin, launcher and licence bytes. Optional release-ready builds require committed unchanged reports, tested-source ancestry and matching payload; default development packages remain closed. The published source-77 sequence-18 package repeated actual installation, execution, update and recovery checks before publication. Metadata changes cannot supply execution evidence. See [build and reproducibility scope](BUILD.md#reproducibility-and-release-status).

For local development builds and candidate verification, use [BUILD.md](BUILD.md) and the current source's release tooling. A closed development candidate is not a public release.
