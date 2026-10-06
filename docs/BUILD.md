# Build and package

Use Node 24.11.1, npm 11.7.0 and the committed lockfile. npm installs the exact TypeScript, zod and workspace dependency closure. No private package registry or project credentials are needed for source builds.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run privacy
npm run setup:project
```

The source workflow checks reachable history for privacy and project identity. Ubuntu 24.04 also builds the Linux helpers and a closed package fixture, then runs Linux controller, hostile-boundary and package checks. Windows x64 can build the AppContainer runtime and controller helpers with the pinned Roslyn toolchain and bundles the controller entry with pinned esbuild. The native controller fixture requires an explicit neutral root and toolchain; it skips when those are absent. Passing source/package tests does not certify a Windows release.

Use `npm.cmd` in Windows PowerShell. Project setup installs branded commit identity and privacy hooks only when no other hook path is configured; existing identity hooks are preserved.

## Linux native helpers

Linux x64 packages require GCC and three separately built helpers. Keep generated files in a neutral build directory, such as `.cache/native-linux`:

```sh
mkdir -p .cache/native-linux
node scripts/public-worker/build-linux-sandbox.mjs .cache/native-linux
node scripts/public-worker/build-linux-controller.mjs .cache/native-linux
node scripts/public-worker/build-linux-egress-peer.mjs .cache/native-linux
```

The helpers are `excess-sandbox` (`linux-landlock-v1`), `excess-controller` (`linux-controller-namespaces-v1`) and `excess-egress-peer` (`linux-af-unix-peercred-v1`). Each builder writes a SHA-256 integrity file. Builds use compiler hardening and path mapping, but the system GCC and C library are local dependencies; the build is not hermetic.

The controller requires a non-root x64 process, user and network namespace support, Landlock ABI 6 or newer, seccomp, and a dedicated cgroup v2 user service named `excess-worker.service`. The controller verifies finite memory, zero swap, task-count and CPU limits from that outside cgroup and refuses to start if they are missing. The default service is capped at 75% of detected memory, at most 12 GiB, with swap disabled, at most 128 tasks and at most 200% CPU. See [native build inputs](NATIVE-BUILD.md) and [platform status](PLATFORMS.md).

To create a **closed local package fixture** after building the TypeScript workspace and helpers:

```sh
npm run build
node scripts/package-worker.mjs --platform linux-x64 --native-dir .cache/native-linux --require-native --out .cache/linux-package
```

The package manifest deliberately records `publicDistributionReady: false`, `controller.verified: false`, `cpuVerified: false` and `gpuVerified: false`. It contains no models or model runtimes. Packaging is not installation or release approval.

## Windows x64

Windows x64 packages require a Windows x64 builder and the pinned C# AppContainer helpers. Prepare the pinned Roslyn and .NET Framework reference inputs described in [native build inputs](NATIVE-BUILD.md), then build the runtime sandbox and controller into the same neutral native output directory:

```sh
node scripts/public-worker/build-windows-sandbox.mjs <neutral-native-output> <pinned-toolchain-root>
node scripts/public-worker/build-windows-controller.mjs <neutral-native-output> <pinned-toolchain-root>
```

The package builder bundles the fixed controller entry with pinned esbuild and records its input digests. The controller fixture runs only when an explicit neutral fixture root and the pinned toolchain are supplied; otherwise it reports a skip. The Windows controller now requests signed update status through a fixed host RPC. The host uses the paired origin and current signed package state it captured itself, while the child receives no URL, version override or installer operation. Automatic installation stays disabled on Windows. Building helpers and packaging bytes do not certify final-package installation, production update behavior or hardware support.

To run the native sandbox and controller fixtures from the repository root on Windows x64 with Node 24.11.1, prepare the pinned toolchain first. The roots below are approved fixture locations; keep the sandbox root at its exact helper-approved base. With these inputs, the native sandbox and controller fixtures passed 3/3 with no skips or failures. Without them, the tests skip the native cases.

```powershell
npm.cmd run build
python scripts/public-worker/prepare-windows-toolchain.py
$toolchain = '.cache/native-toolchain/windows'
$env:EXCESS_WINDOWS_SANDBOX_TEST_ROOT = 'C:/ExcessBuilds/tools/excess-sandbox-runs'
$env:EXCESS_WINDOWS_SANDBOX_TOOLCHAIN = $toolchain
$env:EXCESS_WINDOWS_CONTROLLER_TEST_ROOT = 'C:/ExcessBuilds/windows-controller-multiplex-proof'
$env:EXCESS_WINDOWS_CONTROLLER_TOOLCHAIN = $toolchain
$env:EXCESS_WINDOWS_CONTROLLER_TEST_NODE_SHA256 = 'f13ac3ca23248dc389507e8fe38c34489ab7edb3e6d6700eb6da6a0b7e128eaf'
$controllerRoot = $env:EXCESS_WINDOWS_CONTROLLER_TEST_ROOT
New-Item -ItemType Directory -Path (Join-Path $controllerRoot 'sibling') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $controllerRoot 'sibling/ungranted.txt') -Value 'fixture sibling value' -NoNewline -Encoding ascii
node --input-type=module -e "import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; import { nodeRuntime } from './scripts/public-worker/node-runtime.mjs'; const runtime = await nodeRuntime(process.cwd(), 'win32-x64'); const target = join(process.env.EXCESS_WINDOWS_CONTROLLER_TEST_ROOT, 'runtime'); await mkdir(target, { recursive: true }); await writeFile(join(target, 'node.exe'), runtime.binary); await writeFile(join(target, 'LICENSE'), runtime.license);"
node --test --test-concurrency=1 tests/windows-sandbox.test.mjs tests/windows-controller.test.mjs
```

The Node runtime helper inspects the pinned official archive in memory and returns only the verified binary and license used by the controller fixture. The native fixtures cover controller refusal and cleanup, sandbox loopback denial and allowed relay, native memory observations, cancellation and queue behavior, and ACL restoration. They do not verify final-package model execution, installation or production signed updates.

```sh
node scripts/package-worker.mjs --platform win32-x64 --require-native --out <neutral-build-output>
```

The Windows helper requires the .NET Framework runtime. That runtime and the operating system remain external execution dependencies. Pinned compiler/reference inputs and matching helper bytes do not establish independent reproducibility of Windows, the CLR, Node.js, GPU drivers or upstream model-runtime binaries.

## Reproducibility and release status

Archive ordering, timestamps, modes and ownership are deterministic. `SOURCE_DATE_EPOCH` defaults to the source commit time; `EXCESS_RELEASE_SEQUENCE` selects the positive release sequence. The package scripts use pinned official Node 24.11.1 archive hashes and preserve Node and zod licence notices. They inspect selected bytes before persistence. The upstream Linux Node binary contains its public iojs build-service path; this is upstream provenance, not a local builder identity. Absolute Windows home paths and the project's blocked owner identifier remain forbidden.

No release has been published. Local reproducible builds establish artifact equality only. A locally signed, closed candidate may be used to test signature and update-verifier behavior; its signature does not certify runtime readiness. Windows signed update reporting is implemented, but production signed-update exchange and package installation have not been established. Automatic installation is disabled on Windows. Production distribution, external coordinator/payment execution and GPU support remain unverified or closed. Do not publish a binary from this source preview.
