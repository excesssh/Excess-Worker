# Installation and packaging

There is no public worker release to download. Build from this source tree or create a local package for review. Locally generated packages are not published releases, even when their signatures have been checked locally.

## Build from source

The root manifest pins Node 24.11.1 and npm 11.7.0. In Windows PowerShell use npm.cmd.

    npm ci
    npm run build
    npm test

Run the CLI from the repository root:

    node apps/worker/dist/main.js guide
    node apps/worker/dist/main.js doctor

The EXCESS_WORKER_HOME environment variable selects worker state, and EXCESS_MODEL_DIR selects model and runtime storage. Without them, source runs use .local/worker and .local/ai relative to the current directory. Packaged launchers set defaults under the current user's local data directory.

## Package locally

After a successful build, the package script can create a Windows x64 package on Windows x64 or a Linux x64 package. It verifies pinned official Node archives in memory and persists only the selected runtime binary and required licence. Linux packages also require the compiled sandbox helper; see BUILD.md.

    node scripts/package-worker.mjs --platform win32-x64
    node scripts/package-worker.mjs --platform linux-x64

Use the platform you intend to review. The script writes a directory and archive below .cache/package by default; --out "<directory>" selects another output directory. The pinned Node licence is included automatically. Default builds keep publicDistributionReady false. Exact source74 signed candidate15 passes fresh application installation and funded Windows CUDA/CPU and WSL Linux CPU buyer journeys. Optional --release-ready requires committed payload-bound execution evidence; controlled signed HTTPS updates and downgrade protection now pass; final eligible-package execution, real recovery inference and public feed/download checks remain mandatory before publication. See VERIFICATION.md for current evidence and historical reports. The manifest's codeSigned field describes operating-system code signing; it does not report Minisign status. The project Minisign public key is in releases/minisign.pub. Candidate signing and verification are performed locally after builds; there is no live published signed release.

Inspect manifest.json, ONBOARDING.txt, licenses/, and SHA256SUMS.txt in the generated directory. Verify hashes with sha256sum -c SHA256SUMS.txt on Linux, or compare each entry with Get-FileHash -Algorithm SHA256 on Windows PowerShell. A matching checksum is an integrity check; it is not a publisher signature. The scripts in scripts/worker-install verify the project Minisign signature, pinned key, archive size and hash, source binding, safe extraction and monotonic release sequence. Default installation refuses closed candidates. The explicit verification-candidate mode used by the recorded signed-package journeys permits testing those exact signed candidates without opening public distribution. Windows has no trusted Authenticode publisher signature; anonymous project Minisign authenticates the release. See VERIFICATION.md for the exact installation evidence and commands.

The package intentionally excludes Windows redistributable binaries. The model installer verifies the pinned system Visual C++ Redistributable prerequisite before installing the native runtime.

## First run

A coordinator deployment is external to this repository. Pairing requires its reachable origin and matching interface:

    excess-worker pair "<coordinator-origin>" "workstation"

If no origin is supplied, the CLI tries http://127.0.0.1:4310. That default is only useful when a coordinator is running locally. Approve the displayed code and fingerprint in the matching interface, then run excess-worker complete-pairing.

Review the catalog and local hardware report before choosing a model:

    excess-worker models
    excess-worker use "<model-id>" [--gpu]
    excess-worker model-plan

Installing downloads requires explicit consent:

    excess-worker install-model --accept-download --accept-licenses

The model catalog can change with source history. Check the model's current license and expected disk use before installation. A successful install does not prove that a model can execute under every filesystem or isolation profile.
