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

The installer scripts check the signature, package identity, sizes, hashes and archive paths. By default they inspect and stage archive contents, then refuse installation with closed package flags, remove staging and return a nonzero status. For deliberate local verification of an actual project-signed closed candidate, use `-VerificationCandidate` on Windows or `--verification-candidate` on Linux with a separate install root. The option preserves signature, identity, hash, archive, high-water and native isolation checks. It cannot promote readiness or enable GPU execution or automatic updates. They do not execute a downloaded script.

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

The [source64 packaged CPU report](verification/packaged-cpu-source64.json) binds both local archives, complete package inventories, controller helpers and entry files to unchanged package bytes. Windows and Linux each completed a real Qwen3-4B CPU buyer job, returned `Ready.` (three tokens), drained, released the runtime lock and revoked the device. The existing model was read in place. Windows measured 3,606 MiB probe peak RSS under its 4,096 MiB native limit; Linux measured 3,617 MiB probe RSS with an 8 GiB configured service cap. The Linux systemd summary's 512 KiB peak is excluded from model-memory evidence. Both runs used a local fixture coordinator, ephemeral TLS and synthetic PGlite accounting. Fresh extraction is separate from positive verified installation, and all package release flags remain closed.

An earlier Windows CPU journey used prototype helper `cabf33e536646cc8a4dfb88fb7af9e25e31ad0fd7cd12f7760e124226ed8cc2a`, local TLS, PGlite and a synthetic ledger. It records a real local CPU journey through that prototype; it does not verify the updated final package, its hardware isolation or a production coordinator.

Linux kernel and package fixtures test specific namespace, broker, resource and archive boundaries. The CI suite does not set release verification flags. The Linux package marks `publicDistributionReady`, `controller.verified`, `cpuVerified` and `gpuVerified` false. The installer therefore stops after validation, and Linux package auto-install remains unavailable.

Windows source now implements host-owned signed update reporting: the trusted host captures the paired origin and current signed package release, and the confined controller can request only a fixed check and receives a validated result. The host uses the existing signed release checker; the child cannot supply a URL, version override or installer command. Windows automatic installation is disabled, and the manual signed host-side CLI update path remains. These implementation boundaries do not establish a production signed update exchange or successful package installation.

The [Windows controller and sandbox native fixtures](verification/windows-controller-fixtures.json) passed 3/3 with no skips or failures when run with the exact neutral roots and pinned toolchain in [build instructions](BUILD.md). They cover the documented controller refusal/cleanup, sandbox network boundary, cancellation, queue, memory observation and ACL restoration cases; they do not verify final-package model execution, installation or a production signed update.

Windows [control concurrency checks](verification/windows-control-concurrency.json) reproduce transient lock-open failures under simultaneous stop/run requests and verify bounded retry with 1,024 real control writes. Ownership checks and the existing lock deadline remain in force. This is local control evidence, not a signed-install or model-execution claim.

Before publication, bind the exact source revision, helper hashes and complete archive bytes to independent builds. Complete bootstrap, positive installation, restart, signed update, rollback, drain and revocation checks on supported clean hosts. Verify each advertised backend using the exact packaged workload. Linux also requires the bounded cgroup v2 service and supported namespace, Landlock and seccomp features. Positive installation on clean hosts, production signed-update behavior, GPU execution remain unverified. The scoped local CPU jobs do not establish these gates.
Ubuntu 24.04 hosted CI temporarily permits unprivileged user namespaces on its disposable runner and restores the previous AppArmor sysctl in an always-run step. The namespace probe must then pass before the native fixtures run. This is an explicit CI host prerequisite, not evidence that every default Ubuntu host permits the production profile. See the [Ubuntu 24.04 namespace restrictions](https://documentation.ubuntu.com/release-notes/24.04/). Production launch continues to fail closed when its host disallows the required namespaces.

Anonymous Minisign signing is the release authentication gate. Windows binaries have no trusted Authenticode publisher signature; certificates and identity verification are outside scope. Superseded-repository deletion is a separate migration task and does not gate a release.

The Windows streaming host bridge distinguishes the required chunk sequence from the host-owned heartbeat counter. The focused and standalone regression evidence is in `verification/streaming-chunk-regression.json`; real signed-package buyer verification remains required.
