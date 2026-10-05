# Build and package

Use Node 24.11.1, npm 11.7.0 and the committed lockfile. npm installs the exact TypeScript, zod and workspace dependency closure. No private package registry or project credentials are needed for source builds.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run privacy
npm run setup:project
```

The source verification workflow builds and tests this standalone workspace on Ubuntu 24.04 and Windows Server 2022 with read-only repository access and pinned actions. It checks every reachable commit for privacy and project identity. It does not establish model execution or release readiness.

Use npm.cmd in Windows PowerShell. Project setup installs branded commit identity and privacy hooks only when no other hook path is configured; existing identity hooks are preserved.

Linux x64 packages require GCC and the native helper:

```sh
node scripts/public-worker/build-linux-sandbox.mjs
```

The helper is compiled with path-prefix mapping, no debug information, hardening flags and a checked binary hash. Its system compiler and C library are presently observed local dependencies, not a hermetic pinned build environment. Linux execution requires a non-root process and Landlock ABI 6 or newer; unsupported profiles refuse execution. The Windows C# helper is a separate unintegrated prototype, built with the installed .NET Framework compiler and not included as an operational Windows execution boundary.

```sh
node scripts/package-worker.mjs --platform win32-x64 --out <neutral-build-output>
node scripts/package-worker.mjs --platform linux-x64 --out <neutral-build-output>
```

Windows packaging requires a Windows x64 builder. Both packages use pinned official Node 24.11.1 archive hashes, preserve Node and zod licence notices, and inspect selected bytes before persistence. The upstream Linux Node binary contains its public iojs build-service path; this is upstream provenance, not a local builder identity. Absolute Windows home paths and the project's blocked owner identifier remain forbidden.

Archive ordering, timestamps, modes and ownership are deterministic. SOURCE_DATE_EPOCH defaults to the source commit time; EXCESS_RELEASE_SEQUENCE selects the positive release sequence. Packages always carry publicDistributionReady=false while the isolated model and bootstrap gates are incomplete.

Compare packages from two independent clean directories at the same source commit. Securely inject the project-controlled Minisign secret into EXCESS_WORKER_MINISIGN_KEY, set EXCESS_MINISIGN to the reviewed Minisign executable, then prepare a local candidate:

```sh
node scripts/public-worker/release.mjs <build-a/packages> <build-b/packages> <candidate-output>
```

The script scans source history, requires byte-identical archives, binds their names to the full source commit, signs release.json and verifies it with both the bundled verifier and Minisign. Key material is stored briefly in a user-only directory and removed. Keep the signing key in secure project credential storage and never commit it or place it in shell arguments.

CANDIDATE.txt records the closed publication gate. Matching builds on this machine establish per-artifact local reproducibility; they do not establish independent hardware execution, a hermetic native build, or universal reproducibility.
