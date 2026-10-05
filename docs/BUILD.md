# Build and package

Use Node 24.11.1, npm 11.7.0 and the committed lockfile. npm installs the exact TypeScript, zod and workspace dependency closure. No private package registry or project credentials are needed for source builds.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run privacy
npm run setup:project
```

The source workflow checks reachable history for privacy and project identity. Ubuntu 24.04 also builds the Linux helpers and a closed package fixture, then runs Linux controller, hostile-boundary and package checks. Windows Server 2022 validates the Windows adapter and source build; it does not run a Linux controller or establish Windows Node-controller support.

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

Windows x64 packages require a Windows x64 builder and the pinned C# AppContainer helper. Prepare Microsoft compiler and reference assemblies with `python scripts/public-worker/prepare-windows-toolchain.py`, then run `node scripts/public-worker/build-windows-sandbox.mjs`. See [native build inputs](NATIVE-BUILD.md) for exact pins and external dependencies. The current public source contains the Windows adapter boundary, not a Node controller.

```sh
node scripts/package-worker.mjs --platform win32-x64 --require-native --out <neutral-build-output>
```

The Windows helper requires the .NET Framework runtime. That runtime and the operating system remain external execution dependencies. Pinned compiler/reference inputs and matching helper bytes do not establish independent reproducibility of Windows, the CLR, Node.js, GPU drivers or upstream model-runtime binaries.

## Reproducibility and release status

Archive ordering, timestamps, modes and ownership are deterministic. `SOURCE_DATE_EPOCH` defaults to the source commit time; `EXCESS_RELEASE_SEQUENCE` selects the positive release sequence. The package scripts use pinned official Node 24.11.1 archive hashes and preserve Node and zod licence notices. They inspect selected bytes before persistence. The upstream Linux Node binary contains its public iojs build-service path; this is upstream provenance, not a local builder identity. Absolute Windows home paths and the project's blocked owner identifier remain forbidden.

No release has been published. Local reproducible builds establish artifact equality only. A locally signed, closed candidate may be used to test signature and update-verifier behavior; its signature does not certify runtime readiness. Installation, automatic updates, production distribution, external coordinator/payment execution and GPU support remain unverified or closed. Do not publish a binary from this source preview.
