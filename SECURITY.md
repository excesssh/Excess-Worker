# Security

## Reporting

This source candidate has no published security contact or disclosure process. Do not include secrets or exploitable details in a public issue. If the hosting service has private vulnerability reporting enabled, use that channel; otherwise use an already established trusted maintainer contact and ask for a secure route.

## Sensitive local data

Pairing creates a device identity used to authenticate the worker. The private key is protected with current-user DPAPI on Windows and written with mode 0600 on Linux. The state directory also contains identity and delivery state. Keep the directory restricted to the worker account, and do not upload it or attach it to a bug report.

Unpair retires the local identity and pending local result files. Check for work awaiting the coordinator and revoke the old device through the coordinator before handing the computer to another account.

## Downloads and packages

Model installation is opt-in and requires both --accept-download and --accept-licenses. Imported files are checked against the catalog entry. Review each model's terms before use.

The package script writes SHA-256 checksums. Checksums detect accidental changes when compared with a trusted value; they do not authenticate who built or published a package. The current candidate has no signed release or trusted public checksum publication.

## Known isolation limits

The production isolation gate is incomplete. Current evidence includes Linux kernel denials, selected model descriptors on ext4 and DrvFS, actual Linux CPU inference with a local coordinator journey, and Windows AppContainer file/loopback restrictions with a passing contained HTTP/SSE relay fixture. No GPU execution is verified for these profiles. The controller still runs without OS-enforced outbound confinement, and final packaged installation and execution gates remain open. See [platform status](docs/PLATFORMS.md). Do not use those environments for untrusted multi-tenant inference until the blockers have been retested and closed.
