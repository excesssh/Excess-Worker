"""Prepare exact upstream CUDA build inputs without storing unchecked bytes.

Run locally on Linux, before paid hardware. Only the build dependency tree is
selected; examples, tests, models and upstream Git metadata are not exported.
This does not establish GPU execution or isolation evidence.
"""
import argparse
import hashlib
import io
import json
import pathlib
import re
import tarfile
import urllib.request

LLAMA_COMMIT = "5266f24da75dc449bd56cbed7addb9c8e4a6a73e"
SD_COMMIT = "07a85c74cb08cda3aa176f688c5d8f522615e2b9"
BASE = None
IDENTIFIER = bytes([97, 97, 114, 111, 110])


def public_bytes(data):
    lowered = data.lower()
    if IDENTIFIER in lowered or b"".join(bytes([b, 0]) for b in IDENTIFIER) in lowered:
        raise RuntimeError("UPSTREAM_BUILD_INPUT_PRIVACY_BLOCKED")
    if re.search(rb"[a-z]:[\\/]Users[\\/][^\s/\\]+", data, re.I):
        raise RuntimeError("UPSTREAM_BUILD_INPUT_PATH_BLOCKED")


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise RuntimeError("UPSTREAM_SOURCE_TOO_LARGE")
    return data


def source(repo, revision, name, include):
    archive = fetch(f"https://codeload.github.com/{repo}/tar.gz/{revision}")
    files = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        for member in package:
            relative = pathlib.PurePosixPath(member.name).parts[1:]
            if not relative or (relative[0] not in include and "/".join(relative) not in include):
                continue
            if any(part in {"..", "."} for part in relative) or member.issym() or member.islnk():
                raise RuntimeError("UPSTREAM_SOURCE_LINK_OR_PATH_BLOCKED")
            if not member.isfile():
                continue
            path = "/".join(relative)
            data = package.extractfile(member).read()
            public_bytes(path.encode())
            public_bytes(data)
            files.append((path, data))
    # Validate every selected input before writing any selected source bytes.
    root = BASE / name
    pins = {}
    for path, data in files:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        pins[path] = hashlib.sha256(data).hexdigest()
    return {"repository": repo, "commit": revision, "files": pins,
            "upstreamArchiveSha256": hashlib.sha256(archive).hexdigest()}


def main():
    global BASE
    parser = argparse.ArgumentParser(description="Fetch the pinned CUDA build sources into a fresh local root.")
    parser.add_argument("--root", required=True, help="new source/build directory")
    root_arg = pathlib.Path(parser.parse_args().root)
    if root_arg.is_symlink():
        raise SystemExit("BUILD_ROOT_SYMLINK_BLOCKED")
    BASE = root_arg.resolve()
    BASE.mkdir(parents=True, exist_ok=True)
    if any((BASE / name).exists() for name in ("llama", "sd", "source-pins.json")):
        raise RuntimeError("BUILD_ROOT_ALREADY_PREPARED")
    sd_commit = SD_COMMIT
    inputs = {}
    inputs["llama"] = source("ggml-org/llama.cpp", LLAMA_COMMIT, "llama", {
        "CMakeLists.txt", "LICENSE", "cmake", "common", "ggml", "include", "src", "vendor", "tools", "scripts/ui-assets.cmake",
    })
    inputs["sd"] = source("leejet/stable-diffusion.cpp", sd_commit, "sd", {
        "CMakeLists.txt", "LICENSE", "cmake", "ggml", "include", "src", "thirdparty", "examples", "stable-diffusion.h",
    })
    tree = json.loads(fetch(f"https://api.github.com/repos/leejet/stable-diffusion.cpp/git/trees/{sd_commit}"))
    for item in tree["tree"]:
        if item["mode"] == "160000":
            if item["path"] != "ggml":
                raise RuntimeError("UNREVIEWED_UPSTREAM_SUBMODULE")
            inputs["sd-ggml"] = source("ggml-org/ggml", item["sha"], "sd/ggml", {
                "CMakeLists.txt", "LICENSE", "cmake", "include", "src",
            })
    (BASE / "source-pins.json").write_text(json.dumps(inputs, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"sources": {name: {"commit": row["commit"], "files": len(row["files"])}
                                  for name, row in inputs.items()}, "privacy": "passed", "gpuExecution": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:
        print(json.dumps({"failed": str(failure) if isinstance(failure, RuntimeError) else type(failure).__name__}))
        raise SystemExit(1)
