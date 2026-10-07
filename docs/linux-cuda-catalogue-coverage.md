# Linux CUDA catalogue coverage

Status checked 7 October 2026. The published 0.1.0 worker refuses Linux GPU execution. Source 0.2.0 contains a development Linux NVIDIA route, but no Linux CUDA model run or buyer job is verified. The route has an independently reproduced runtime archive pin set for CUDA Toolkit 12.9 Update 1 (nvcc 12.9.86), SM90, with FlashAttention disabled. See the [build recipe](cuda-runtime-reproducibility/README.md).

The shared runtimePinsSha256 fingerprint for this candidate pin set is:

`c797e2c8a5a43bef7dfaa23c11f5aeb942fc48823096ac4164ea085ced6f8b33`

The prepared, unexecuted worker package source is `be93f91d5dac282e37708761e2d0f02095ff7db1`. The intended host is Ubuntu 24.04 x64 with one H100/H200 (SM90). Provider capacity prevented machine creation, so the actual GPU and driver are unset and no model job ran. Every row below has that same configuration and reason.

This digest identifies the runtime pin manifest; it is not a release signature or evidence of hardware execution. No Linux CUDA binary release is published. Every local model entry remains unverified on this route:

| Local model ID | Task | Linux CUDA result |
| --- | --- | --- |
| qwen3-4b | text | Not tested |
| phi-4-mini | text | Not tested |
| qwen3-8b | text | Not tested |
| llama-3.1-8b | text | Not tested |
| qwen3-14b | text | Not tested |
| phi-4 | text | Not tested |
| gpt-oss-20b | text | Not tested |
| qwen3-coder-30b-a3b | text | Not tested |
| qwen3-30b-a3b-instruct-2507 | text | Not tested |
| qwen3-30b-a3b | text | Not tested |
| qwen3-32b | text | Not tested |
| llama-3.3-70b | text | Not tested |
| gpt-oss-120b | text | Not tested |
| qwen3-embedding-0.6b | embedding | Not tested |
| qwen3-asr-0.6b | transcription | Not tested |
| sd-turbo | image | Not tested |
| flux1-schnell | image | Not tested |

Hosted-provider entries are a separate service and do not appear in this local worker matrix.
