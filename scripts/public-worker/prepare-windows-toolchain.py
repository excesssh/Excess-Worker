"""Fetch only hash-pinned compiler inputs; never run downloaded setup programs."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import urllib.request
import uuid
import zipfile

PACKAGES = (
    ("microsoft.net.compilers.toolset", "4.14.0", 21771766,
     "941a9cf3ea618d88d01a3dd6b1a45a06bcf07716a9f81ce4031caa3edd24a845"),
    ("microsoft.netframework.referenceassemblies.net48", "1.0.3", 20997929,
     "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2"),
)
REFERENCES = {"mscorlib.dll", "System.dll", "System.Core.dll", "System.Web.dll",
              "System.Web.Extensions.dll", "System.Xml.dll", "System.Data.dll"}


def check_public(data):
    needle = "aa" + "ron"
    if any(needle.encode(encoding) in data.lower() for encoding in ("utf-8", "utf-16le", "utf-16be")):
        raise ValueError("PRIVATE_IDENTIFIER_DENIED")
    if re.search(rb"(?i)[a-z]:[/\\]Users[/\\]", data):
        raise ValueError("PRIVATE_HOME_PATH_DENIED")


def selected(package, name):
    if name.endswith(".nuspec") or name == "ThirdPartyNotices.rtf":
        return True
    if package.endswith("toolset"):
        return name.startswith("tasks/net472/") and name.endswith((".dll", ".exe", ".config", ".rsp"))
    return name.startswith("build/.NETFramework/v4.8/") and name.rsplit("/", 1)[-1] in REFERENCES and "/Facades/" not in name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=".cache/native-toolchain/windows")
    target = Path(parser.parse_args().output).resolve()
    if target.exists():
        raise ValueError("TOOLCHAIN_OUTPUT_ALREADY_EXISTS")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = target.with_name(target.name + ".stage-" + uuid.uuid4().hex)
    stage.mkdir(mode=0o700)
    inventory = {"format": 1, "packages": [], "files": []}
    try:
        for package, version, size, digest in PACKAGES:
            url = f"https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg"
            request = urllib.request.Request(url, headers={"User-Agent": "Excess-Worker-build"})
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.geturl() != url:
                    raise ValueError("TOOLCHAIN_REDIRECT_DENIED")
                data = response.read(size + 1)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("TOOLCHAIN_ARCHIVE_MISMATCH")
            check_public(data)
            archive = zipfile.ZipFile(io.BytesIO(data))
            entries = []
            seen = set()
            for entry in archive.infolist():
                name = entry.filename
                if not selected(package, name):
                    continue
                path = PurePosixPath(name)
                if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or "\\" in name or ":" in name:
                    raise ValueError("TOOLCHAIN_PATH_DENIED")
                key = name.casefold()
                if key in seen or entry.file_size > 16 * 1024 * 1024 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("TOOLCHAIN_ENTRY_DENIED")
                seen.add(key)
                body = archive.read(entry)
                check_public(name.encode())
                check_public(body)
                entries.append((name, body))
            if not entries:
                raise ValueError("TOOLCHAIN_INPUTS_MISSING")
            for name, body in entries:
                relative = package + "/" + name
                output = stage / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open("xb") as stream:
                    stream.write(body)
                inventory["files"].append({"file": relative, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            inventory["packages"].append({"package": package, "version": version, "url": url, "bytes": size, "sha256": digest})
        manifest = (json.dumps(inventory, indent=2) + "\n").encode()
        check_public(manifest)
        (stage / "inputs.json").write_bytes(manifest)
        stage.rename(target)
        print(json.dumps({"status": "pinned-inputs-ready", "packages": inventory["packages"], "files": len(inventory["files"])}))
    finally:
        if stage.exists():
            if stage.parent != target.parent or not stage.name.startswith(target.name + ".stage-"):
                raise ValueError("TOOLCHAIN_CLEANUP_BOUNDARY_DENIED")
            shutil.rmtree(stage)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    # Error messages deliberately omit filesystem paths and downloaded content.
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", str(error)) else type(error).__name__
        print("toolchain preparation failed: " + code, file=sys.stderr)
        sys.exit(1)
