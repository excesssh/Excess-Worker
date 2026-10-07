#!/usr/bin/env python3
"""Package fixed CUDA runtime inputs as deterministic, flat regular files.

Run locally before paid hardware. The archives and per-file hashes are build
preparation, never GPU execution evidence. NVIDIA drivers are not bundled.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import tarfile
from pathlib import Path

EPOCH = 1726185600
IDENTIFIER = bytes([97, 97, 114, 111, 110])
WIDE = b''.join(bytes([b, 0]) for b in IDENTIFIER)
PATTERNS = [
    rb'[a-z]:[\\/]Users[\\/][^\s/\\]+',
    rb'/mnt/[a-z]/Us' rb'ers/[^\s/]+',
    rb'/(?:home|Us' rb'ers)/(?!excess(?:/|\b)|iojs(?:/|\b))[^\s/]+',
    rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
    rb'(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])',
    rb'https?://[^\s/@:]+:[^\s/@]+@',
]

def check(data):
    if IDENTIFIER in data.lower() or WIDE in data.lower():
        raise RuntimeError('PUBLIC_RUNTIME_IDENTIFIER_BLOCKED')
    if any(re.search(p, data, re.I if i != 2 else 0) for i, p in enumerate(PATTERNS)):
        raise RuntimeError('PUBLIC_RUNTIME_CONTENT_BLOCKED')

def inspect(path, pinned_build_input=False):
    digest = hashlib.sha256()
    overlap = b''
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            data = overlap + chunk
            if pinned_build_input:
                # Private, hash-pinned upstream build inputs are never exported.
                # Keep the original preparation checks; runtime/public artifacts
                # always take the complete strict check above.
                if IDENTIFIER in data.lower() or WIDE in data.lower() or re.search(PATTERNS[0],data,re.I):
                    raise RuntimeError('UPSTREAM_BUILD_INPUT_PRIVACY_BLOCKED')
            else:
                check(data)
            overlap = chunk[-65536:]
    return {'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}

def prepare_repro(root, repro):
    pins = json.loads((root / 'source-pins.json').read_text(encoding='utf-8'))
    selected = []
    for key, row in pins.items():
        subdir = 'sd/ggml' if key == 'sd-ggml' else key
        for relative, expected in row['files'].items():
            parts = Path(relative).parts
            if any(p in {'.', '..'} for p in parts) or Path(relative).is_absolute():
                raise RuntimeError('BUILD_SOURCE_PATH_BLOCKED')
            check(relative.encode())
            source = root / subdir / relative
            if source.is_symlink() or inspect(source, pinned_build_input=True)['sha256'] != expected:
                raise RuntimeError('BUILD_SOURCE_PIN_MISMATCH')
            selected.append((source, repro / subdir / relative))
    for source, target in selected:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    shutil.copyfile(root / 'source-pins.json', repro / 'source-pins.json')
    print(json.dumps({'reproSources': len(selected), 'scope': 'pinned upstream inputs; identifier and personal Windows path checks passed'}))

def archive(base, name, files):
    rows = {}
    for leaf, source in files:
        check(leaf.encode())
        if '/' in leaf or leaf in rows or not source.is_file():
            raise RuntimeError('RUNTIME_ARCHIVE_ENTRY_INVALID')
        rows[leaf] = inspect(source)
    output = base / 'archives' / name
    output.parent.mkdir(exist_ok=True)
    with output.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=EPOCH, compresslevel=6) as compressed:
            with tarfile.open(mode='w|', fileobj=compressed, format=tarfile.USTAR_FORMAT) as package:
                for leaf, source in sorted(files):
                    entry = tarfile.TarInfo(leaf)
                    entry.size = rows[leaf]['bytes']
                    entry.mode = 0o755 if leaf in {'llama-server','sd-server'} else 0o644
                    entry.mtime = EPOCH
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    with source.open('rb') as stream:
                        package.addfile(entry, stream)
    return {**inspect(output), 'files': rows, 'regularFilesOnly': True}

def package(base, cuda_lib_dir, cudart_license, cublas_license):
    cuda = cuda_lib_dir
    selected_cuda = [(n, (cuda / n).resolve(strict=True)) for n in ['libcudart.so.12','libcublas.so.12','libcublasLt.so.12']]
    licences = [('NVIDIA-CUDA-EULA.txt', cudart_license.resolve(strict=True)),
                ('NVIDIA-cuBLAS-EULA.txt', cublas_license.resolve(strict=True))]
    reports = {}
    reports['cuda-12.9-linux-x64-libraries.tar.gz'] = archive(base, 'cuda-12.9-linux-x64-libraries.tar.gz', selected_cuda + licences)
    for project, executable, archive_name in [
        ('llama','llama-server','llama-b10809-linux-x64-cuda12.9-sm90.tar.gz'),
        ('sd','sd-server','sd-07a85c7-linux-x64-cuda12.9-sm90.tar.gz')]:
        directory = base / (project + '-build-12.9') / 'bin'
        files = [(p.name, p.resolve(strict=True)) for p in directory.iterdir()
                 if p.name == executable or re.fullmatch(r'lib[^/]+\.so(?:\.[0-9]+)*', p.name)]
        if not any(n == executable for n, _ in files):
            raise RuntimeError('RUNTIME_EXECUTABLE_MISSING')
        files.append((project + '-MIT.txt', base / project / 'LICENSE'))
        reports[archive_name] = archive(base, archive_name, files)
    reports['configuration'] = {'cuda':'12.9','nvcc':'12.9.86','architecture':'SM90','cpuNative':False,'flashAttention':False,
        'driverBundled':False,'executionEvidence':False,'sourceDateEpoch':EPOCH,
        'sources':json.loads((base/'source-pins.json').read_text(encoding='utf-8')),
        'vocabularyStoragePatch':json.loads((base/'vocab-storage-patch.json').read_text(encoding='utf-8')),
        'imageAuthenticationPatch':json.loads((base/'sd-auth-patch.json').read_text(encoding='utf-8'))}
    (base/'runtime-archives.json').write_text(json.dumps(reports,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({n:{k:v for k,v in row.items() if k in {'bytes','sha256'}} for n,row in reports.items() if n!='configuration'}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Create deterministic CUDA runtime archives and local provenance records.')
    parser.add_argument('--root', required=True, help='primary source/build root')
    parser.add_argument('--repro-root', required=True, help='independent reproduction source/build root')
    parser.add_argument('--cuda-root', default=os.environ.get('CUDA_HOME', '/usr/local/cuda-12.9'))
    parser.add_argument('--cuda-lib-dir')
    parser.add_argument('--cudart-license', default='/usr/share/doc/cuda-cudart-12-9/copyright')
    parser.add_argument('--cublas-license', default='/usr/share/doc/libcublas-12-9/copyright')
    parser.add_argument('--prepare-repro', action='store_true')
    parser.add_argument('--repro', action='store_true')
    args = parser.parse_args()
    root_arg, repro_arg = Path(args.root), Path(args.repro_root)
    if root_arg.is_symlink() or repro_arg.is_symlink():
        raise SystemExit('BUILD_ROOT_SYMLINK_BLOCKED')
    root, repro = root_arg.resolve(), repro_arg.resolve()
    if args.prepare_repro:
        prepare_repro(root, repro)
    else:
        base = repro if args.repro else root
        cuda_lib = Path(args.cuda_lib_dir).resolve() if args.cuda_lib_dir else Path(args.cuda_root).resolve() / 'targets/x86_64-linux/lib'
        package(base, cuda_lib, Path(args.cudart_license), Path(args.cublas_license))
