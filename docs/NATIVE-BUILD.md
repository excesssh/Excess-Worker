# Native worker boundaries

Native helpers are built separately from the TypeScript workspace. A source build or a fixture pass does not make a package installable or establish GPU support. The binary release remains closed.

## Linux x64

Build all three helpers into a directory outside the source package:

```sh
mkdir -p .cache/native-linux
node scripts/public-worker/build-linux-sandbox.mjs .cache/native-linux
node scripts/public-worker/build-linux-controller.mjs .cache/native-linux
node scripts/public-worker/build-linux-egress-peer.mjs .cache/native-linux
```

`excess-sandbox` applies the adapter's Landlock and seccomp restrictions. `excess-controller` is the trusted launcher/supervisor for the worker controller. It creates private user, mount, PID, network, IPC and UTS namespaces; constructs a small private mount tree; drops capabilities and restricts syscalls before executing pinned Node 24.11.1. The controller sees the immutable app and selected model/runtime subdirectories read-only; it receives state only through bounded broker operations, not a writable host-state mount. Its scratch area is a size-limited tmpfs. It has no host home, model download cache, GPU device, host PID tree or direct network route.

`excess-egress-peer` checks the accepted AF_UNIX stream peer credentials and verifies that the peer is in the expected controller network namespace. The broker remains outside that namespace. It validates the configured canonical HTTPS origin, resolves public unicast addresses, applies an exact method/path allowlist, bounds request and response sizes and timeouts, and validates TLS. This is a narrow coordinator bridge, not a general proxy. The separate state broker exposes bounded worker-state operations over its own Unix socket; it does not grant the controller a writable host state mount.

The controller also requires an outside cgroup v2 user service named `excess-worker.service`. It reads and validates `memory.max`, `memory.swap.max`, `pids.max` and `cpu.max` before start. The current accepted range caps memory at 12 GiB, requires swap to be zero and at most 128 tasks, and caps CPU at 200%. The default user unit selects at most 75% of detected memory with a 256 MiB floor. Missing or broader limits fail closed. Provisioning an appropriate systemd user session/cgroup is an operating-system prerequisite; running the native fixture does not prove that a machine is configured for release use.

The builders use the host GCC and libc development files with source/path mapping, stripping and hardening options. Those toolchain inputs are observed local dependencies; the build is not hermetic. The kernel must support unprivileged user namespaces, seccomp and Landlock ABI 6 or newer. No helper permits GPU device access. Review [platform status](PLATFORMS.md) and [security](../SECURITY.md) for evidence and limits.

## Windows x64

Prepare the exact compiler inputs without running a downloaded installer:

```powershell
python scripts/public-worker/prepare-windows-toolchain.py
New-Item -ItemType Directory -Path .cache/native-windows
node scripts/public-worker/build-windows-sandbox.mjs .cache/native-windows .cache/native-toolchain/windows
node scripts/public-worker/build-windows-controller.mjs .cache/native-windows .cache/native-toolchain/windows
```

Python 3 downloads Microsoft.Net.Compilers.Toolset 4.14.0 and Microsoft.NETFramework.ReferenceAssemblies.net48 1.0.3 from NuGet over HTTPS. The script checks their fixed sizes and SHA-256 digests in memory, checks selected names and bytes for privacy traces, and extracts only the required compiler files, reference assemblies and attribution. It refuses an existing output directory.

Each builder checks the pinned inventory digest and every extracted input before invoking the compiler. Compilation disables default response files, implicit framework references and debug symbols, uses explicit reference assemblies, enables deterministic output, and maps source/tool paths. Sources are copied into temporary build directories; only the corresponding helper executable and integrity file become runtime payloads. Temporary source files are removed after compilation. The Windows controller entry is bundled by the package builder with pinned esbuild so its confined process does not need directory enumeration for module resolution.

Optional arguments select output and prepared-toolchain directories:

```powershell
node scripts/public-worker/build-windows-sandbox.mjs .cache/native-a .cache/native-toolchain/windows
node scripts/public-worker/build-windows-sandbox.mjs .cache/native-b .cache/native-toolchain/windows
node scripts/public-worker/build-windows-controller.mjs .cache/native-a .cache/native-toolchain/windows
node scripts/public-worker/build-windows-controller.mjs .cache/native-b .cache/native-toolchain/windows
```

The helpers require the Windows .NET Framework runtime. Windows source includes an AppContainer Node controller with a typed host broker and a separate model-runtime sandbox. The trusted host keeps the Windows device signing key outside the AppContainer and performs signed release checks using its captured paired origin and current package release. The controller receives only a fixed status-check operation; Windows automatic installation stays disabled, and the manual signed host-side CLI update flow remains. With the approved fixture roots and pinned toolchain documented in [build instructions](BUILD.md), the Windows controller and sandbox native fixtures passed 3/3 with no skips or failures. Those tests establish the covered native boundaries only; they do not establish updated final-package model execution, positive installation, production signed-update behavior, hardware execution or platform signing. The runtime and operating system remain external execution dependencies. Pinned compiler/reference inputs and matching helper bytes do not establish independent reproducibility of Windows, the CLR, Node.js, GPU drivers or upstream model-runtime binaries.

## Verification and release

Linux CI builds the helpers, creates a package fixture with the three integrity pins, and runs the kernel and package tests on an Ubuntu runner. Windows packages include separate AppContainer runtime and controller pins. Package manifests remain closed and set controller, CPU and GPU verification false. Local Linux CPU integration evidence uses a fixture coordinator and synthetic ledger; it is not real funding, external-service proof or install evidence.

Build final candidates from independent clean source directories and compare the complete archive bytes. Bind helper hashes, tool inputs, upstream exceptions and actual execution evidence to that exact source commit. A locally signed, closed candidate may be used for signature and update-verifier tests; the signature does not attest runtime isolation, hardware execution or release readiness. Publish only after all runtime, bootstrap, installation, OS, privacy and reproducibility gates have passed. Those gates are not complete and no binary release has been published.
