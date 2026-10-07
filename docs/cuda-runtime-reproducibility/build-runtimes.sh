#!/bin/sh
set -eu
base=${EXCESS_CUDA_CANONICAL_ROOT:-}
[ "$base" = /var/tmp/excess-cuda-canonical ] || { echo CANONICAL_BUILD_PATH_REQUIRED >&2; exit 2; }
[ -f "$base/source-pins.json" ] || { echo PINNED_SOURCE_TREE_REQUIRED >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
export CUDACXX=${CUDACXX:-/usr/local/cuda-12.9/bin/nvcc}
[ -x "$CUDACXX" ] || { echo PINNED_NVCC_NOT_FOUND >&2; exit 2; }
export SOURCE_DATE_EPOCH=1726185600
common='-DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=90 -DGGML_NATIVE=OFF -DGGML_CUDA=ON -DGGML_CUDA_F16=ON -DGGML_CUDA_FA=OFF -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON'
launcher="python3;$script_dir/nvcc-launcher.py"
cmake -S "$base/llama" -B "$base/llama-build-12.9" -G Ninja $common \
  -DCMAKE_CUDA_COMPILER="$CUDACXX" -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_BUILD_APP=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_UI=OFF \
  -DLLAMA_BUILD_NUMBER=10809 -DLLAMA_BUILD_COMMIT=5266f24 -DLLAMA_USE_PREBUILT_UI=OFF \
  '-DCMAKE_INSTALL_RPATH=$ORIGIN' \
  "-DCMAKE_C_FLAGS=-ffile-prefix-map=$base=." "-DCMAKE_CXX_FLAGS=-ffile-prefix-map=$base=." \
  "-DCMAKE_CUDA_FLAGS=-Xcompiler=-ffile-prefix-map=$base=." \
  "-DCMAKE_CUDA_COMPILER_LAUNCHER=$launcher"
cmake --build "$base/llama-build-12.9" --target llama-server --parallel 4
cmake -S "$base/sd" -B "$base/sd-build-12.9" -G Ninja $common \
  -DCMAKE_CUDA_COMPILER="$CUDACXX" -DSD_CUDA=ON -DSD_WEBP=OFF -DSD_WEBM=OFF \
  -DSD_BUILD_EXAMPLES=ON '-DCMAKE_INSTALL_RPATH=$ORIGIN' \
  "-DCMAKE_C_FLAGS=-ffile-prefix-map=$base=." "-DCMAKE_CXX_FLAGS=-ffile-prefix-map=$base=." \
  "-DCMAKE_CUDA_FLAGS=-Xcompiler=-ffile-prefix-map=$base=." \
  "-DCMAKE_CUDA_COMPILER_LAUNCHER=$launcher"
cmake --build "$base/sd-build-12.9" --target sd-server --parallel 4
