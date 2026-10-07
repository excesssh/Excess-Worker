# Local model catalogue

The local source catalogue contains **17 pinned entries: 13 text models and four media models**. A catalogue entry or hardware-fit estimate does not establish successful execution. As of 7 October 2026, the source catalogue separately contains **43 hosted-provider entries** through its provider integration; these are a distinct service and cannot be installed on a supplier worker. The hosted inventory can change independently of the pinned local catalogue.

Download totals below include pinned model parts and licence files, in decimal GB. Memory is estimated GiB at the adapter's configured context and includes its documented buffers. Runtime downloads are additional and shared by models using the same backend. Allow free system memory, installation cache/disk space and a resource budget above measured peaks. FLUX requires GPU execution.

| Model / CLI ID | Task | Quantization | Download GB | RAM GiB | VRAM GiB | Licence |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Qwen3 4B<br>`qwen3-4b` | text | Q4_K_M | 2.50 | 4 | 4 | Apache-2.0 |
| Phi-4 mini 3.8B<br>`phi-4-mini` | text | Q4_K_M | 2.49 | 4.5 | 4 | MIT |
| Qwen3 8B<br>`qwen3-8b` | text | Q4_K_M | 5.03 | 7 | 6.5 | Apache-2.0 |
| Llama 3.1 8B Instruct<br>`llama-3.1-8b` | text | Q4_K_M | 4.92 | 7 | 6.5 | Llama 3.1 Community |
| Qwen3 14B<br>`qwen3-14b` | text | Q4_K_M | 9.00 | 11 | 10.5 | Apache-2.0 |
| Phi-4 14B<br>`phi-4` | text | Q4_K_M | 9.05 | 11 | 10.5 | MIT |
| gpt-oss 20B (reasoning)<br>`gpt-oss-20b` | text | MXFP4 | 12.11 | 12.5 | 12 | Apache-2.0 |
| Qwen3 Coder 30B-A3B<br>`qwen3-coder-30b-a3b` | text | Q4_K_M | 18.56 | 19.5 | 19 | Apache-2.0 |
| Qwen3 30B-A3B Instruct 2507<br>`qwen3-30b-a3b-instruct-2507` | text | Q4_K_M | 18.56 | 19.5 | 19 | Apache-2.0 |
| Qwen3 30B-A3B (mixture-of-experts)<br>`qwen3-30b-a3b` | text | Q4_K_M | 18.56 | 20 | 19.5 | Apache-2.0 |
| Qwen3 32B<br>`qwen3-32b` | text | Q4_K_M | 19.76 | 21.5 | 21 | Apache-2.0 |
| Llama 3.3 70B Instruct<br>`llama-3.3-70b` | text | Q4_K_M | 42.52 | 43.5 | 43 | Llama 3.3 Community |
| gpt-oss 120B (reasoning)<br>`gpt-oss-120b` | text | MXFP4 | 63.39 | 60.5 | 60 | Apache-2.0 |
| Qwen3 Embedding 0.6B<br>`qwen3-embedding-0.6b` | embedding | Q8_0 | 0.64 | 1.5 | 1 | Apache-2.0 |
| Qwen3 ASR 0.6B<br>`qwen3-asr-0.6b` | transcription | Q8_0 | 1.02 | 2 | 1.5 | Apache-2.0 |
| SD-Turbo<br>`sd-turbo` | image | Q8_0 | 2.02 | 4 | 3 | Stability-AI-Community |
| FLUX.1 schnell<br>`flux1-schnell` | image | Q4_0 | 9.74 | 16 (GPU required) | 12 | Apache-2.0 |

## Adapter routes and execution evidence

| Adapter | Implemented pinned runtime routes in 0.1.0 | Verified configuration in the current signed release |
| --- | --- | --- |
| Text | llama.cpp b10809: Windows CPU/CUDA; Linux CPU/Vulkan | Qwen3-4B: Windows 11 x64 CPU; Windows RTX 3070 Ti 8 GiB, driver 596.49, CUDA, separate 6 GiB host/GPU budgets; WSL2 Linux CPU in a bounded systemd user service. |
| Embeddings and transcription | llama.cpp b10809: Windows CPU/CUDA; Linux CPU/Vulkan | No current signed-release buyer execution evidence for these adapters. |
| Images | stable-diffusion.cpp master-869-07a85c7: Windows CPU/CUDA; Linux CPU/Vulkan | No current signed-release buyer execution evidence for these adapters. |

Implementation of a runtime route does not establish admission by the isolation profile or execution on a machine. **0.1.0 refuses Linux GPU execution. Windows CUDA admission is restricted to Qwen3-4B.** Other text models and media adapters remain individually unverified in the current signed release. Earlier unconfined execution reports are historical and do not verify the current boundaries. See [measured platform requirements](PLATFORMS.md) and [signed release evidence](VERIFICATION.md#current-evidence). Source 0.2.0 now has an independently reproduced CUDA 12.9 Update 1/SM90 runtime pin set with FlashAttention disabled; this establishes build inputs only. No Linux CUDA model run or buyer job has been verified. The per-model candidate coverage is recorded in [Linux CUDA catalogue coverage](linux-cuda-catalogue-coverage.md).

## Select, inspect and install

Follow [download verification](VERIFICATION.md#verify-your-download) and [installation](INSTALLATION.md) first. The model name used by the CLI is the ID in the table. For example, choose a CPU entry and inspect all exact downloads and licences before consenting:

```sh
excess-worker models
excess-worker use phi-4-mini --cpu
excess-worker model-plan
excess-worker install-model --accept-download --accept-licenses
```

`models` reports the complete local catalogue and estimated hardware fit, including entries too large for this machine. `model-plan <id>` lists exact URLs, sizes, hashes, capability digest, runtime and model licences. The worker checks pinned bytes; install success is separate from a successful probe or buyer job. [Importing existing pinned model files](MODELS.md) also requires licence consent. For the recorded Windows CUDA configuration use `qwen3-4b --gpu`, configure separate 6 GiB host/GPU budgets, then inspect the plan before installation. Linux 0.1.0 suppliers use CPU.

Text is billed per output token, including hidden reasoning tokens for gpt-oss. Embeddings use input tokens, transcription uses audio seconds and images use image count. gpt-oss needs an output budget of at least 256 tokens to reach an answer. A supplier worker serves one selected model at a time and publishes offers only after a recent successful local probe; selecting another entry changes the capability and its offer. A buyer can select an entry without current supply but cannot purchase it until a matching eligible offer is available. Catalogue visibility and live supply are separate.

## Exact pins and licences

All model parts, runtime artifacts, model revisions, licence URLs, hashes, limits and prompt formats are defined in [the manifest](../packages/adapters/src/manifest.ts). The [machine-readable inventory](../evidence/model-catalogue-inventory.json) lists every model artifact and licence pin. Licence consent covers the selected model and runtime; retain original pinned licence and tokenizer bytes. Licence labels here do not replace the full terms.

Development-source CLI selection keeps RAM/VRAM estimates separate from selectable operating-system/backend profiles and recorded execution evidence. The installation plan separately describes pinned downloads and consent. A fitting size estimate does not override a refused backend or establish that a model will run; a successful installation still needs the local probe and an eligible live offer. The published 0.1.0 package retains its existing interface and restrictions.
