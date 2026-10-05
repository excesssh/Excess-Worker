# Native worker boundary builds

Native helpers are built separately from the TypeScript workspace. A source build alone does not establish isolation or hardware support. The release stays closed until the packaged boundary completes actual supported workloads and lifecycle checks.

## Windows x64

Prepare the exact compiler inputs without running a downloaded installer:

```powershell
python scripts/public-worker/prepare-windows-toolchain.py
node scripts/public-worker/build-windows-sandbox.mjs
```

Python 3 downloads Microsoft.Net.Compilers.Toolset 4.14.0 and Microsoft.NETFramework.ReferenceAssemblies.net48 1.0.3 from NuGet over HTTPS. The script checks their fixed sizes and SHA-256 digests in memory, checks selected names and bytes for privacy traces, and extracts only the required compiler files, reference assemblies and attribution. It refuses an existing output directory.

The builder checks the pinned inventory digest and every extracted input before invoking the compiler. Compilation disables default response files, implicit framework references and debug symbols, uses explicit reference assemblies, enables deterministic output, and maps source/tool paths. The source is copied into a temporary build directory; only `ExcessSandbox.exe` and `integrity-win32.json` become runtime payloads. Temporary source files are removed after compilation.

Optional arguments select output and prepared-toolchain directories:

```powershell
node scripts/public-worker/build-windows-sandbox.mjs .cache/native-a .cache/native-toolchain/windows
node scripts/public-worker/build-windows-sandbox.mjs .cache/native-b .cache/native-toolchain/windows
```

The helper requires the Windows .NET Framework runtime. That runtime and the operating system remain external execution dependencies. Pinned compiler/reference inputs and matching helper bytes do not establish independent reproducibility of Windows, the CLR, Node.js, GPU drivers or upstream model-runtime binaries.

## Linux x64

```sh
node scripts/public-worker/build-linux-sandbox.mjs
```

The current builder uses the host GCC and libc development files, with path mapping, stripping and hardening options. These are observed local dependencies; the build is not yet hermetic. A compatible kernel must expose the required Landlock ABI and seccomp support. GPU access remains unavailable until its supported driver configuration and resource controls pass actual workload verification.

## Release verification

Build the complete final worker from independent clean public-source directories and compare each archive's exact bytes. Bind final helper hashes, tool inputs, upstream exceptions and actual execution evidence to that source commit. Sign the release manifest only after all required release checks pass. A local candidate signature binds its metadata and artifacts; it does not establish hardware execution or public readiness.
