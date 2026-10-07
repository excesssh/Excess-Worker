# Reproducible Linux CUDA runtime build

This directory contains a local source-preparation, build, packaging, and byte-check recipe for the pinned llama.cpp and stable-diffusion.cpp server runtimes. It does not download model weights or user data, provision a cloud machine, or demonstrate GPU execution. Generated build and authentication reports explicitly record `executionEvidence: false`.

The recipe is for Linux x86_64 with Python 3, GitHub source access, CMake, Ninja, a C/C++ toolchain, `g++`, `gzip`, `tar`, util-linux mount tools, and the NVIDIA CUDA 12.9 toolkit. The expected `nvcc` version is 12.9.86. The toolkit's CUDA libraries and the two installed NVIDIA copyright/EULA texts are packaged from the selected local toolkit installation without changing their bytes. No driver is bundled.

## Fixed inputs and build settings

The source fetch is pinned to `ggml-org/llama.cpp` commit `5266f24da75dc449bd56cbed7addb9c8e4a6a73e` and `leejet/stable-diffusion.cpp` commit `07a85c74cb08cda3aa176f688c5d8f522615e2b9`. The latter's `ggml` gitlink is read from that pinned commit. Only the explicit source directories in `prepare-runtime.py` are selected. The script records a SHA-256 for every selected file and each downloaded source archive; upstream `LICENSE` files are retained byte-for-byte.

The two server configurations use CUDA architecture 90 (SM90), `GGML_NATIVE=OFF`, CUDA F16 enabled, `GGML_CUDA_FA=OFF`, Release mode, build number 10809 and llama commit label `5266f24`. Tests and examples are disabled for llama.cpp; its server is enabled and the UI, app and curl integrations are disabled. The stable-diffusion server example is enabled, with WebP and WebM disabled. `SOURCE_DATE_EPOCH` is fixed at `1726185600`; source/build paths are mapped to `.`. Each CUDA translation unit gets a deterministic seed from its canonical path relative to `/var/tmp/excess-cuda-canonical`. `nvcc-launcher.py` also passes `--objdir-as-tempdir`, which stabilizes temporary intermediate filenames in CUDA object symbols. This option alone does not establish archive equality.

FlashAttention is disabled in this Linux configuration because repeated pinned CUDA 12.9 compilation of some flash-attention template units produced different final objects. Matrix-multiply and other CUDA kernels remain compiled. Linux CUDA text, embedding and transcription launchers explicitly select `--flash-attn off`; image-server FlashAttention switches remain disabled. This may reduce attention performance. Only an actual matching full A/B archive comparison establishes reproducibility, and only the recorded hardware jobs establish execution support.

The tokenizer-table preparation verifies each upstream source hash, compresses and decodes the exact embedded bytes, and records original and derived hashes. The server authentication preparation verifies the original pinned server source before adding bearer authentication and allowing only `GET /v1/models` and `POST /v1/images/generations`. These are source transformations; original model or licence data is not rewritten.

## Independent build procedure

Use two new empty roots on the same pinned toolchain. Keep the tool directory at the same path for both builds. Do not point either root at an existing source, model, package, or frozen build tree.

```sh
TOOLS=/opt/excess-cuda-reproducibility
WORK=/var/tmp/excess-cuda-repro
ROOT_A="$WORK/a"
ROOT_B="$WORK/b"
mkdir -p "$ROOT_A" "$ROOT_B"

python3 "$TOOLS/prepare-runtime.py" --root "$ROOT_A"
python3 "$TOOLS/package-runtimes.py" --root "$ROOT_A" --repro-root "$ROOT_B" --prepare-repro

python3 "$TOOLS/prepare-sd-vocab.py" --root "$ROOT_A"
python3 "$TOOLS/prepare-sd-auth.py" --root "$ROOT_A"
python3 "$TOOLS/prepare-sd-vocab.py" --root "$ROOT_B"
python3 "$TOOLS/prepare-sd-auth.py" --root "$ROOT_B"

export EXCESS_CUDA_BUILD_ROOT="$ROOT_A"
sudo --preserve-env=EXCESS_CUDA_BUILD_ROOT unshare --mount --propagation private -- "$TOOLS/build-canonical.sh"
export EXCESS_CUDA_BUILD_ROOT="$ROOT_B"
sudo --preserve-env=EXCESS_CUDA_BUILD_ROOT unshare --mount --propagation private -- "$TOOLS/build-canonical.sh"
```

Each build runs as root only inside a fresh private mount namespace. The source/build root is temporarily bind-mounted at the fixed canonical path; the mount is removed when the script exits, and the namespace disappears with `unshare`. The scripts reject a build root that overlaps that canonical mount point. The work root should be on a filesystem with enough free space for two source trees and build outputs.

Run local byte/auth checks for each root, then make deterministic archives. If the CUDA toolkit is installed somewhere other than the defaults, export `CUDACXX` to its CUDA 12.9.86 `nvcc` path before both builds, and pass the same `--cuda-root`, `--cuda-lib-dir`, `--cudart-license`, and `--cublas-license` values to both packaging runs.

```sh
for ROOT in "$ROOT_A" "$ROOT_B"; do
  python3 "$TOOLS/verify-sd-vocab.py" --root "$ROOT"
  python3 "$TOOLS/verify-sd-auth.py" --root "$ROOT"
done

python3 "$TOOLS/package-runtimes.py" --root "$ROOT_A" --repro-root "$ROOT_B"
python3 "$TOOLS/package-runtimes.py" --root "$ROOT_A" --repro-root "$ROOT_B" --repro

diff -u "$ROOT_A/runtime-archives.json" "$ROOT_B/runtime-archives.json"
sha256sum "$ROOT_A"/archives/*.tar.gz "$ROOT_B"/archives/*.tar.gz
```

The packager uses a strict identifier, personal-path, private-key, credential, and URL-credential scan on every packaged runtime file and archive. Pinned upstream source inputs receive the existing narrower provenance-aware check and are never included as source archives in the runtime package. Archive entries are sorted regular files with fixed timestamps, ownership, and modes. The original application and NVIDIA licence bytes are included unchanged. `diff` and SHA-256 equality are necessary reproducibility checks; they do not by themselves establish runtime safety or GPU support.

## Scope of evidence

`source-pins.json`, patch reports, local tokenizer-byte checks, local HTTP auth/route checks, archive hashes, and exact A/B byte equality establish only the corresponding local source, build, and packaging facts. They do not show that a runtime starts on an NVIDIA device, completes inference, survives cancellation, or is safe under adversarial execution. GPU execution and end-to-end worker support remain unverified by this recipe. Do not promote a product GPU claim or release pin from these instructions alone; a reviewed release record must bind the final archive hashes to the exact source, toolchain, and verification evidence.
