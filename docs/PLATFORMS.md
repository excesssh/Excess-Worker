# Platform status

The source contains CPU and GPU backend selection and packaging paths for Windows x64 and Linux x64. Those code paths do not establish support. The current candidate's isolation and execution evidence has material gaps.

| Area | Current evidence | Status |
| --- | --- | --- |
| Linux ext4 | Kernel denials and selected model descriptors pass. | Fixture evidence; packaged clean-host verification pending. |
| Linux CPU | Actual Qwen3-4B inference and a local coordinator job returned useful output through the isolated adapter. Pairing, accepted receipt, drain and revocation passed. | Development evidence with synthetic local funding; packaged clean-host verification pending. |
| Linux DrvFS | Exact read-only model descriptors resolve the prior permission failure; the selected file is readable and an unselected sibling is denied. | Verified in the development environment; no model copy required. |
| Windows AppContainer | Outside loopback is denied; same-container authenticated HTTP/SSE pulls, selected-file denial and timeout/stop cleanup pass native fixtures. | Actual worker/model execution remains unverified. |
| GPU | No GPU execution was verified. | Unverified; no GPU support claim. |
| Production isolation | Required gate is incomplete. | Not ready for production or multi-tenant untrusted work. |

The current code selects CUDA for --gpu on Windows and Vulkan for --gpu on Linux. These are implementation choices, not test evidence. A hardware inventory, successful driver discovery, model-fit estimate, or health probe is not proof that a real GPU executed inference.

The source doctor quick start works as a local inventory command; it is not a model execution test. Before claiming platform support, test the exact packaged build on a clean host, record filesystem and isolation settings, run a real model through the worker, and verify results and shutdown behavior. Repeat for every claimed backend. Keep fixture, CPU, GPU, and production evidence separate.
