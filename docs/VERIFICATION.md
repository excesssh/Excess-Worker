# Verify a local candidate

No worker release has been published. These steps are for a locally prepared, signed candidate and future release files. A signature authenticates release metadata and artifact hashes; it does not certify isolation, honest work, device-key custody or hardware execution.

## Check the manifest signature

Establish the project's Minisign public key from a trusted source checkout. A key downloaded beside an untrusted archive does not provide independent trust. The checked-in key is [minisign.pub](../releases/minisign.pub).

With Minisign installed, verify the manifest signature:

```sh
minisign -Vm release.json -x release.json.minisig -p releases/minisign.pub
```

Then compare the archive name, byte count and SHA-256 with the authenticated platform entry in `release.json`. The manifest binds version, increasing release sequence, source commit, exact filenames and hashes, declared isolation and reproducibility results.

The local candidate builder compares complete archives from two independent build directories and signs the resulting metadata. It requires `EXCESS_WORKER_MINISIGN_KEY` to be supplied from private credential storage:

```sh
node scripts/public-worker/release.mjs <build-a/packages> <build-b/packages> <candidate-out>
```

Signing is permitted for a closed local candidate used by verifier and update tests. The candidate remains closed; its signature is not evidence that runtime or release gates passed.

## Verify-only installer behavior

The installer scripts check the signature, package identity, sizes, hashes and archive paths. With the current closed package flags, they then refuse extraction and installation and return a nonzero status. They do not execute a downloaded script.

```sh
sh scripts/worker-install/install.sh release.json release.json.minisig <exact-linux-archive>
```

```powershell
powershell -NoProfile -File scripts/worker-install/install.ps1 release.json release.json.minisig <exact-windows-archive>
```

These commands validate a local candidate and demonstrate the expected closed-gate refusal; they are not an installation path. No public installer or binary release is available.

## Other checks are separate

The website's local file checker compares the selected manifest's exact filename, size and SHA-256. It does not verify Minisign in the browser. Job-receipt checking is separate and verifies only the signed fields for the supplied device key.

The local Linux CPU integration report at [verification/linux-controller-cpu.json](verification/linux-controller-cpu.json) used a fixture HTTPS coordinator, ephemeral test CA, test-only PGlite and synthetic ledger. It records one paired CPU job, a three-token output and receipt, a drain request, clean exit, lock release and revocation. It is local integration evidence only: no public coordinator, production database, chain-backed funds, payment, installed package or GPU execution was involved.

Linux kernel and package fixtures test specific namespace, broker, resource and archive boundaries. The CI suite does not set release verification flags. The Linux package marks `publicDistributionReady`, `controller.verified`, `cpuVerified` and `gpuVerified` false. The installer therefore stops after validation, and automatic updates remain unavailable.

Before publication, bind the exact source revision, helper hashes and complete archive bytes to independent builds. Complete bootstrap, install, restart, update, rollback, drain and revocation checks on supported clean hosts. Verify each advertised backend using the exact packaged workload. Linux also requires the bounded cgroup v2 service and supported namespace, Landlock and seccomp features. Windows source currently provides the adapter boundary only. GPU execution has not been verified.
Ubuntu 24.04 hosted CI temporarily permits unprivileged user namespaces on its disposable runner and restores the previous AppArmor sysctl in an always-run step. The namespace probe must then pass before the native fixtures run. This is an explicit CI host prerequisite, not evidence that every default Ubuntu host permits the production profile. See the [Ubuntu 24.04 namespace restrictions](https://documentation.ubuntu.com/release-notes/24.04/). Production launch continues to fail closed when its host disallows the required namespaces.
