# Windows 0.2.3: distant-buyer streaming, cancellation and three worker faults

Recorded 21-22 October 2026 on the operator-funded testnet. Supplier: published Excess Worker 0.2.3 (sequence 32), fresh Windows install, Windows 11 x64, RTX 3070 Ti 8 GiB (driver 596.49), pinned Qwen3-4B and SD-Turbo. Policies: CUDA two threads with 6 GiB host and 6 GiB GPU budgets; CPU text four threads and 4.25 GiB; CPU image eight threads and 8 GiB; 300-second job limit. The buyer ran on the same workstation in the UK; the coordinator was in New York. These results cover only this configuration. No Linux supplier, other GPU or buyer in another region was tested.

## Distant-buyer streaming

The buyer's fetch layer added 150 ms or 450 ms before every request and before every response-body read, including each streamed chunk. Measured buyer round trips: about 100 ms natural, about 565 ms and about 1,465 ms. Qwen3-4B on CUDA counted upward; 800 tokens were requested at the first two settings and 400 at the last.

| Buyer round trip | 0.2.2 buyer SDK | 0.2.3 buyer SDK |
| --- | --- | --- |
| ~100 ms | 2 of 2 completed, every token acknowledged | 2 of 2 completed |
| ~565 ms | 1 of 1 completed | 2 of 2 completed |
| ~1,465 ms | 0 of 2: the stream failed with HTTP 409 `ACCOUNTING_FINALIZED` after about half the tokens were acknowledged; the job settled only the acknowledged prefix | 2 of 2 completed, 400 of 400 tokens acknowledged |

In every completed run the result signature verified and coordinator accounting matched the acknowledged tokens. The distant-buyer failure noted for 0.2.2 reproduces with the 0.2.2 SDK and does not occur with the 0.2.3 SDK in this configuration.

Generation ran at about 10-13 tokens per second in every run, well below this GPU's unthrottled rate, because the worker waits for a coordinator round trip per chunk. The buyer's distance did not change that rate.

## Cancellation stops runtime work

The buyer cancelled while the runtime was busy. Runtime CPU and GPU use were sampled every 100 ms before and after the cancellation.

| Route | Busy before cancellation | Worker stopped the job | Runtime process exited | Charge |
| --- | --- | --- | --- | --- |
| CUDA text | 24 tokens streamed, GPU 87% | 439 ms | 447 ms; GPU idle at 171 ms | 40 tokens |
| CPU text | 24 tokens, 3.9 cores busy | 440 ms | 417 ms | 40 tokens |
| CPU image | 6.0 cores busy, 15 s into generation | 5.1 s | 5.1 s | none |
| CUDA image | generation finished in about 2 s | 5.6 s | finished on its own | none; no output delivered |

Text cancellation reaches the worker at its next chunk round trip. Image cancellation reaches it at the next lease renewal, about five seconds. At the market maximum (512 x 512, 4 steps, 4 images) SD-Turbo finishes in about two seconds on this GPU, so a mid-generation CUDA image cancellation could not be observed. No runtime activity followed any abort, and the worker took the next job after each cancelled text job.

## Worker faults found

All three faults are in published 0.2.3 on Windows. Their fixes are on `main` and are not yet in a release; they need a 0.2.4 release and a live recheck.

- **Non-ASCII text.** The Windows controller and sandbox relay read and wrote their parent channel in the console code page. A prompt with non-ASCII characters failed with `job_input_identity_mismatch`, and a streamed chunk with non-ASCII characters failed with `invalid_adapter_chunk`. Both helpers now use UTF-8, and the fixture tests round-trip non-ASCII text in both directions.
- **Warm runtime stopped mid-job.** A warm runtime kept the time limit of the job that started it (the job limit plus five seconds), so a later job failed with `adapter_runtime_timeout` about 300 seconds after the runtime started, here after 776 tokens. Linux derives its helper limit the same way; this was reproduced on Windows only. Helpers now have a fixed 600-second lifetime, and the runtime restarts before a job that lifetime does not cover.
- **Worker stops after a failed job.** After reporting a failed job, the Windows worker kept the attempt open, so its next poll failed and the worker stopped. It now closes the attempt after any successful failure report. Buyer cancellations did not trigger this.

The fixes passed fixture and unit tests, including the full test suite on Windows, but have not run against a real worker, native helper or GPU.

Not tested: on Linux CPU the sandbox's time limit is a CPU-time limit across all runtime threads, so a long-lived Linux CPU runtime may still be stopped after 605 CPU-seconds in total. This comes from reading the code; no Linux CPU run reproduced it.
