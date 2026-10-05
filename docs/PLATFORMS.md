# Platform status

The source contains CPU and GPU backend selection and packaging paths for Windows x64 and Linux x64. Those code paths do not establish support. The current candidate's isolation and execution evidence has material gaps.

| Area | Current evidence | Status |
| --- | --- | --- |
| Linux ext4 | The isolated fixture passed. | Limited fixture evidence only. |
| CPU end-to-end | The standalone reconstruction has not been revalidated with a real end-to-end CPU job. | Unverified for release claims. |
| Linux DrvFS | Model file permissions prevented inference. | Blocked in the tested configuration. |
| Windows AppContainer | Outside loopback is denied; same-container authenticated HTTP/SSE pulls, selected-file denial and timeout/stop cleanup pass native fixtures. | Actual worker/model execution remains unverified. |
| GPU | No GPU execution was verified. | Unverified; no GPU support claim. |
| Production isolation | Required gate is incomplete. | Not ready for production or multi-tenant untrusted work. |

The current code selects CUDA for --gpu on Windows and Vulkan for --gpu on Linux. These are implementation choices, not test evidence. A hardware inventory, successful driver discovery, model-fit estimate, or health probe is not proof that a real GPU executed inference.

The source doctor quick start works as a local inventory command; it is not a model execution test. Before claiming platform support, test the exact packaged build on a clean host, record filesystem and isolation settings, run a real model through the worker, and verify results and shutdown behavior. Repeat for every claimed backend. Keep fixture, CPU, GPU, and production evidence separate.
