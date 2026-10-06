# Security

## Reporting

This source preview has no published security contact or disclosure process. Do not include secrets or exploitable details in a public issue. If the hosting service has private vulnerability reporting enabled, use that channel; otherwise use an already established trusted maintainer contact and ask for a secure route.

## Sensitive local data

Pairing creates a device identity used to authenticate the worker. The private key is protected with current-user DPAPI on Windows and written with mode 0600 on Linux. The Linux Node controller reads its device credential from a read-only state mount and signs the allowed device protocol; the separate model runtime receives no device key. The host owns heartbeat sequence persistence, the runtime lock and state writes through a narrow broker. Keep the state directory restricted to the worker account, and do not upload it or attach it to a bug report.

Unpair retires the local identity and pending local result files. Check for work awaiting the coordinator and revoke the old device through the coordinator before handing the computer to another account.

## Model files and packages

Model installation is opt-in and requires both `--accept-download` and `--accept-licenses`. Imported files are checked against the catalog entry. Review each model's terms before use.

Package checksums detect accidental changes when compared with a trusted value; they do not authenticate a publisher. The release public key is distributed in the source tree, but no public release has been published. A locally signed, closed candidate may exercise signature and update-verifier behavior; its signature does not certify runtime isolation, model behavior, hardware execution or public readiness.

The Windows model installer verifies the pinned system Visual C++ redistributable prerequisite; the redistributable binaries are not bundled. Windows source includes a Node AppContainer controller, a typed host broker and a separate adapter runtime sandbox. The controller receives no identity-file or state-directory mount and has no direct network capability. The documented native controller/sandbox fixtures passed 3/3. Host-owned signed update reporting is implemented through a fixed bounded RPC; the child cannot supply an origin, release override or installer command. The source64 package completed a local isolated CPU job and confirmed reap/cleanup, but positive installation and a production signed update exchange remain unverified.

## Linux controller boundary

Linux x64 execution uses three native helpers. The controller isolates the worker in private user, mount, PID, network, IPC and UTS namespaces, mounts app/model/runtime views read-only, provides no writable host-state mount, limits scratch to a 256 MiB tmpfs, removes direct network access, drops capabilities and applies syscall restrictions. A Unix-socket broker outside the network namespace checks `SO_PEERCRED` and exact network-namespace device/inode identity before serving bounded coordinator routes. A separate state broker mediates a small allowlist of state operations. The host retains the writable identity file, heartbeat counters, update policy and runtime lock. The Node controller can read the device key and read-only state; writes pass through the state broker.

The whole process must already run inside the dedicated, bounded `excess-worker.service` cgroup v2 boundary. Missing or unsupported kernel features, helper hashes, namespace identity or cgroup limits fail closed. Linux kernel fixtures verify denied host paths/processes/direct network, broker peer identity and process/mount cleanup. A local Qwen3 CPU job using unchanged source64 package bytes passed through the read-only entry against a fixture coordinator, test-only PGlite and synthetic ledger. The Linux systemd peak counter is excluded from model-memory evidence; the scoped report distinguishes probe RSS and configured service limits. This is not real funding, an external service, a published package or multi-tenant certification.

## Remaining limits

A device signature identifies its key; it does not attest honest execution. The Linux coordinator broker validates routes and bounds, and the separate coordinator validates job state and results. This boundary does not bind every signed result to host-observed adapter execution. Runtime package hashes check consistency; the install-time signed archive is the trust anchor, and the per-user install/state are not protected against their owning user.

No GPU execution is verified. The Linux GCC/libc native build is not hermetic. The installer checks local signatures, sizes and hashes but intentionally refuses to install while bootstrap and release gates remain closed; automatic updates and public binary release are unavailable. Keep the worker off untrusted multi-tenant workloads until the exact signed package, installation lifecycle and supported host configurations pass their release gates. See [platform status](docs/PLATFORMS.md) and [verification scope](docs/VERIFICATION.md).
