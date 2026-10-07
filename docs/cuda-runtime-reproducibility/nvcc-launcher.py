#!/usr/bin/env python3
"""Assign a stable, distinct CUDA symbol seed to each translation unit."""
import hashlib
import os
import subprocess
import sys
from pathlib import Path

root = Path(os.environ.get('EXCESS_CUDA_CANONICAL_ROOT', '/var/tmp/excess-cuda-canonical')).resolve()
sources = [Path(arg) for arg in sys.argv[2:] if arg.endswith('.cu')]
if len(sources) != 1:
    raise SystemExit('CUDA_TRANSLATION_UNIT_REQUIRED')
source = sources[0].resolve()
try:
    relative = source.relative_to(root).as_posix()
except ValueError:
    raise SystemExit('CUDA_SOURCE_ROOT_MISMATCH') from None
seed = hashlib.sha256(relative.encode('ascii')).hexdigest()[:16]
result = subprocess.run([sys.argv[1], '--objdir-as-tempdir', '--frandom-seed=0x' + seed, *sys.argv[2:]])
raise SystemExit(result.returncode)
