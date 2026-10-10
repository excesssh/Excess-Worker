# Published sequence-26 Qwen3-8B Linux WSL CPU buyer verification

This record covers two actual Qwen3-8B CPU buyer routes using signed Excess Worker 0.2.0, release sequence 26, on Linux x64 under WSL. The observed run completed on 10 October 2026: one full-success route and one prefix-cancel route. This is evidence for that recorded WSL CPU setup only.

## Package, model and runtime pins

- Release: Excess Worker 0.2.0, sequence 26; worker source commit `8724162f793d3ec009eb2f64f713a05c29857bd7`.
- Linux x64 archive SHA-256: `446a98d1fb14fcc568c8a8856ff5e59fd1c2e1d19a4cdb58021134c5dcb3c268`; release manifest SHA-256: `d2eaa9a53be7c33d507b558501b4a89a0baa44772ef9ca4432a53d5d8e78c565`.
- Model route: `qwen3-8b`, CPU backend, one model file; recorded capability digest: `bd95d1b913e2d322832950cd643c54984b3db80e7dccf897a0a551bae4ed4e0b`.
- The route record reports 60 runtime files and 2 pinned runtime files read back through the signed worker CLI installation/model-readback path. The signed package archive and manifest bind the package contents.
- Recorded limits: 2 worker threads, 8 GiB memory maximum, and no swap. GPU execution is unverified.

## Full-success route and output authentication

The observer record marks the buyer route as passed and records a meaningful 128-token response. It marks output signature verification and proof verification as successful. The report gives the raw-output SHA-256 `70942d9bc914b0c1ad3ef68451310cdc05dd49e8f7ea9d0e86c44c8cffca52c0` and signed-output digest `b7df8de77de89f66cbde5df27d42621f422149c5645ceb7e08684c15f732e2db`. Its signature scope is the verified output; it does not cover accounting. The retained route report contains verification flags and digests, not the output body, so this page does not reconstruct or quote that text. The [sanitized observer-record JSON](qwen3-8b-linux-wsl-cpu.json) records the role-labelled report digests and observer verification fields; the underlying reports remain private, and the JSON is not independent public receipt validation.

## Prefix-cancel route

The second route passed its cancellation and cleanup checks after acknowledging sequence 1 and 8 output tokens. It produced no final-result signature: the report marks the final result signature absent and unverified, and the cancellation proof absent. This route is not presented as a signed final result.

## Accounting, checked separately

The observer record describes actual buyer API/SDK requests and separate buyer and supplier wallet readbacks. It marks the buyer available-balance change against gross, supplier net delta, reservation reconciliation and price arithmetic as verified. The output signature does not sign these accounting fields.

| Route | Gross units | Net units | Fee units | Buyer available decrease | Supplier net delta | Additional accounting |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Full success | 143 | 128 | 15 | 143 | 128 | Buyer hold released; buyer and supplier wallet checks passed. |
| Prefix cancel | 9 | 8 | 1 | 9 | 8 | 134 unused hold units released; buyer and supplier wallet checks passed. |

## Lifecycle and limits

The checkpoint and route records mark the worker stopped with its cgroup empty, scratch data removed, device revoked, and local pairing removed for both routes. They record the complete lifecycle and cleanup checks as passed. These are observer-recorded run results. The listed archive, manifest and output hashes are reference pins; they do not independently verify a receipt signature or attest hardware identity.

This result does not establish bare-metal Linux compatibility, general Windows execution, GPU support, or a hardware-identity claim. For user-side package authentication, follow [download verification](../VERIFICATION.md#verify-your-download) and the [installation guide](../INSTALLATION.md). See also [supported configurations](../PLATFORMS.md#published-sequence-26-linux-wsl-cpu-evidence) and the [model catalogue](../MODEL-CATALOG.md).
