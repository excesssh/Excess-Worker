# Architecture and scope

This repository contains the supplier-side worker packages. It is not a coordinator, marketplace or settlement service.

```text
Separately operated coordinator
          ^
          | fixed HTTPS routes; paired-origin TLS
    host egress broker ----------------- host worker/service
          ^                                  | device identity, host lock,
          | authenticated AF_UNIX peer       | offers, lifecycle, update decision
          |                                  v
    private Linux controller <---------- state broker
      user/mount/PID/network/IPC/UTS       bounded AF_UNIX operations
          |
          +-- read-only app, selected models/runtimes and state; broker-mediated writes
          +-- 256 MiB scratch tmpfs
          +-- local model runtime
```

The Linux host owns the writable identity file, heartbeat counters, runtime lock and lifecycle decisions. The Node controller reads the device signing key and state through a read-only mount to authenticate its allowlisted device messages. The controller runs under pinned Node 24.11.1 inside private user, mount, PID, network, IPC and UTS namespaces. Its mount tree exposes the installed application and only selected model/runtime subdirectories read-only. It has no direct network route, host home, download cache, general writable state, GPU devices or host process tree. A dedicated systemd user service places the whole worker in an outside cgroup v2 boundary before execution; the controller fails closed if that boundary is absent or outside its accepted limits.

Two Unix-socket services remain outside the controller's writable view. The egress broker authenticates the connected controller using peer credentials and the exact network-namespace identity. It only forwards bounded, allowlisted requests to the configured HTTPS coordinator after address and TLS checks; it is not a general proxy. The state broker offers bounded operations on the small set of worker state files. The controller cannot write the host state directory directly. The host retains update policy and waits for the controller process tree to be reaped before acting on an update request.

`excess-sandbox` supplies the adapter-level Landlock/seccomp restrictions. `excess-controller` creates and supervises the Linux process and filesystem boundary. `excess-egress-peer` verifies the broker's Linux peer identity. Their profiles and build inputs are described in [native build](NATIVE-BUILD.md).

The Windows path includes a pinned AppContainer Node controller and a typed host broker. The controller has no direct coordinator route, state-directory mount or identity-file grant; the trusted host retains the device signing key, paired origin, coordinator access and managed state, and exposes typed operations over bounded pipes. The separately supervised model runtime uses its own AppContainer and selected read-only files. The host captures the paired origin and current signed package release, runs the existing signed release checker and returns an exact validated status result through a no-payload update-check operation. The child cannot select an origin, version, URL or installer command. Windows automatic installation is disabled; the manual signed host-side CLI update flow remains. The Windows controller and sandbox native fixtures passed 3/3 with the approved roots and pinned toolchain documented in [build instructions](BUILD.md). They do not prove final-package model execution, installation, production update exchange or release readiness. The Linux and Windows code paths are separate and neither establishes GPU support.

`apps/worker` owns the CLI, device pairing and identity, local policy, offers, polling, execution, result delivery and shutdown. `packages/adapters` describes catalog entries, installs pinned runtimes and model files after explicit consent, supervises local inference processes, parses streaming text and handles buffered media outputs. `packages/protocol` defines signed message and request/result shapes shared at that boundary.

Coordinator services, PostgreSQL, object storage, buyer interface, scheduler, wallet and settlement signer are external. This repository does not define the coordinator's retention, access or deletion behavior; review that service's data handling before sending real inputs or outputs.

Linux CPU integration evidence uses a local fixture coordinator, test-only PGlite and synthetic ledger. It proves one scoped local journey, not production funds, an external coordinator or a published package. An earlier Windows CPU journey used prototype helper `cabf33e536646cc8a4dfb88fb7af9e25e31ad0fd7cd12f7760e124226ed8cc2a`, local TLS, PGlite and a synthetic ledger; it is evidence for that prototype journey only, not the updated final package. See [platform status](PLATFORMS.md).
