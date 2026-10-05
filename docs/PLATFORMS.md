# Platform status

Code paths are not a support claim. The Linux x64 controller boundary has passed native kernel fixtures and one local CPU integration journey. Downloadable packages, installation, automatic updates, public production service and GPU execution are not verified for release.

| Area | Evidence | Status |
| --- | --- | --- |
| Linux controller boundary | Linux x64 fixtures verify private mount/PID/network namespaces, read-only app/model/state views and broker-mediated state writes, absent host paths/processes, direct-network denial, peer authentication, broker restrictions, cleanup and stop reaping. A bounded cgroup v2 service is required by the production entry. | Source/kernel fixture evidence; the package manifest still marks the controller unverified and closed. |
| Linux CPU job | Qwen3-4B Q4_K_M through llama.cpp on CPU, two threads and an 8 GiB configured memory cap. A local fixture HTTPS coordinator and test-only PGlite database used a synthetic ledger. Pairing, a three-token result/receipt, draining, clean exit, host-lock release and revocation passed; model bytes were unchanged. | Local integration evidence only. No chain backing, paid demand, public coordinator, real payment or downloadable install. See [the scoped report](verification/linux-controller-cpu.json). |
| Linux model paths | Selected model/runtime trees are mounted read-only by descriptor. The controller exposes only `ai/models`, `ai/runtimes` and optional `ai/sd-runtimes`; unrelated store siblings are not mounted. | Local ext4/DrvFS and hostile fixture evidence; no general filesystem compatibility claim. |
| Linux resources | The controller fails closed without a dedicated `excess-worker.service` cgroup v2 boundary. Its policy requires swap 0, at most 128 tasks, at most 200% CPU and memory no higher than 12 GiB. Scratch is a 256 MiB tmpfs. | Kernel/package fixtures and local user-cgroup proof; no published installation/bootstrap. |
| Windows x64 | The published source includes the pinned AppContainer adapter helper and Windows CPU adapter path. The helper and adapter fixtures, including HTTP/SSE relay, pass; an actual local Qwen3-4B CPU adapter probe passed. | Adapter evidence only. The source has no Node controller; packaged journey and release remain unverified. |
| GPU | No GPU execution has been verified on either platform. The source's CUDA/Vulkan selections are implementation choices. | Unverified. Do not claim GPU support. |
| Install, update and release | Installer scripts verify local metadata and archives but intentionally refuse installation while bootstrap and safety gates are closed. No release has been published; automatic updates are unavailable. | Closed. |

The local CPU report is not evidence of a live coordinator, funded demand, an external production database, real payments or a public binary. Fixture jobs and synthetic accounting stay separate from production evidence. A health probe or inventory listing is not proof of inference.

Before widening support, run the exact signed package through bootstrap, installation, restart, update, rollback, drain and revocation on clean supported hosts. Verify actual outputs and clean shutdown with each claimed backend. Keep CPU, GPU, fixture and external-service evidence separate.
