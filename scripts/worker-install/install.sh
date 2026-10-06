#!/bin/sh
# Verify and install a local signed worker package for the current Linux x64 user.
set -eu

usage() {
  cat <<'TEXT'
Usage: sh install.sh release.json release.json.minisig worker-linux-x64.tar.gz [--prefix ABSOLUTE_USER_DIRECTORY] [--verification-candidate]

The three release files must be local. This script verifies the pinned Minisign key and
the signed archive digest before extracting. It never downloads or executes a script.
The default install root is ${XDG_DATA_HOME:-$HOME/.local/share}/excess. Put
${EXCESS_INSTALL_ROOT:-$HOME/.local/share/excess}/bin on PATH to use the launcher.
TEXT
}
fail() { printf 'EXCESS worker install: %s\n' "$*" >&2; exit 1; }
[ "$#" -ge 3 ] || { usage; exit 2; }
manifest=$1 signature=$2 archive=$3
shift 3
prefix=${EXCESS_INSTALL_ROOT:-${XDG_DATA_HOME:-"$HOME/.local/share"}/excess}
candidate=0
prefix_seen=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] && [ "$prefix_seen" -eq 0 ] || { usage; exit 2; }; prefix=$2; prefix_seen=1; shift 2 ;;
    --verification-candidate) [ "$candidate" -eq 0 ] || { usage; exit 2; }; candidate=1; shift ;;
    *) usage; exit 2 ;;
  esac
done
[ "$(uname -s)" = Linux ] || fail 'Linux x64 only.'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'Linux x64 only.' ;; esac
[ "$(id -u)" -ne 0 ] || fail 'run as the installing user, not root.'
for tool in minisign python3; do command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required."; done
for file in "$manifest" "$signature" "$archive"; do [ -f "$file" ] && [ ! -L "$file" ] || fail 'manifest, signature, and archive must be regular local files.'; done
manifest_bytes=$(wc -c < "$manifest" | tr -d ' ')
signature_bytes=$(wc -c < "$signature" | tr -d ' ')
archive_bytes=$(wc -c < "$archive" | tr -d ' ')
[ "$manifest_bytes" -ge 2 ] && [ "$manifest_bytes" -le 65536 ] || fail 'release manifest exceeds its 64 KiB bound.'
[ "$signature_bytes" -ge 1 ] && [ "$signature_bytes" -le 10240 ] || fail 'signature exceeds its 10 KiB bound.'
[ "$archive_bytes" -ge 1 ] && [ "$archive_bytes" -le 268435456 ] || fail 'archive exceeds its 256 MiB bound.'

key=$(mktemp)
trap 'rm -f "$key"' EXIT HUP INT TERM
cat > "$key" <<'KEY'
untrusted comment: Excess Worker release signing key
RWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C
KEY
minisign -Vm "$manifest" -x "$signature" -p "$key" >/dev/null || fail 'pinned Minisign signature verification failed.'
rm -f "$key"
trap - EXIT HUP INT TERM

case "$prefix" in /*) ;; *) fail 'install prefix must be an absolute path.' ;; esac
export EXCESS_INSTALL_ROOT="$prefix"
python3 - "$manifest" "$archive" "$archive_bytes" "$candidate" <<'PY'
import fcntl, gzip, hashlib, json, os, re, shutil, stat, sys, tarfile, tempfile
from pathlib import Path, PurePosixPath

MAX_TOTAL = 1024 * 1024 * 1024
MAX_ENTRY = 128 * 1024 * 1024
FLOOR = 1
manifest_path, archive_path, archive_size = sys.argv[1], sys.argv[2], int(sys.argv[3])
verification_candidate = sys.argv[4] == '1'
prefix = Path(os.environ['EXCESS_INSTALL_ROOT'])
platform = 'linux-x64'

class InstallError(Exception): pass
def stop(message):
    raise InstallError(message)
def regular(path):
    try: return stat.S_ISREG(os.lstat(path).st_mode)
    except FileNotFoundError: return False
def safe_components(path, allow_missing=True):
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            mode = os.lstat(current).st_mode
            if stat.S_ISLNK(mode): stop('install path contains a symbolic link')
            if not stat.S_ISDIR(mode) and current != path: stop('install path component is not a directory')
        except FileNotFoundError:
            if not allow_missing: raise
def semver(value):
    return isinstance(value, str) and bool(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value))
def version_key(value):
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?', value)
    if not match: stop('release version is invalid')
    pre = match.group(4)
    return tuple(map(int, match.group(1,2,3))), pre
def compare_versions(left, right):
    core_a, pre_a = version_key(left); core_b, pre_b = version_key(right)
    if core_a != core_b: return (core_a > core_b) - (core_a < core_b)
    if pre_a is None or pre_b is None: return 0 if pre_a == pre_b else (1 if pre_a is None else -1)
    a, b = pre_a.split('.'), pre_b.split('.')
    for x, y in zip(a,b):
        if x == y: continue
        xn, yn = re.fullmatch(r'(0|[1-9][0-9]*)',x), re.fullmatch(r'(0|[1-9][0-9]*)',y)
        if xn and yn: return (int(x) > int(y)) - (int(x) < int(y))
        if bool(xn) != bool(yn): return -1 if xn else 1
        return (x > y) - (x < y)
    return (len(a) > len(b)) - (len(a) < len(b))
def json_bytes(path, limit):
    data = Path(path).read_bytes()
    if len(data) > limit: stop('JSON input exceeds its size limit')
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out: stop('JSON contains duplicate keys')
            out[key] = value
        return out
    return data, json.loads(data.decode('utf-8'), object_pairs_hook=pairs)
def strict_digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''): h.update(block)
    return h.hexdigest()
def path_name(name):
    if not isinstance(name, str) or not name or len(name) > 240 or '\\' in name or name.startswith('/'):
        stop('archive path is invalid')
    parts = name.rstrip('/').split('/')
    if not parts or any(p in ('', '.', '..') or ':' in p or not re.fullmatch(r'[-A-Za-z0-9._+@]+', p) for p in parts):
        stop('archive path is unsafe')
    return parts
def validate_tar(path, folder):
    names, total, count = set(), 0, 0
    with gzip.open(path, 'rb') as stream:
        while True:
            header = stream.read(512)
            if len(header) != 512: stop('tar archive header is truncated')
            if header == bytes(512):
                tail = stream.read(512)
                if tail != bytes(512) or stream.read(1): stop('tar archive has an invalid end marker')
                break
            count += 1
            if count > 4096: stop('archive contains too many entries')
            recorded = header[148:156].strip(b' \0')
            checksum_header = bytearray(header); checksum_header[148:156] = b'        '
            if not re.fullmatch(rb'[0-7]{1,7}', recorded) or sum(checksum_header) != int(recorded,8) or not header[257:263].startswith(b'ustar'):
                stop('tar archive header is invalid')
            def field(value): return value.split(b'\0',1)[0].decode('ascii')
            leaf, prefix = field(header[0:100]), field(header[345:500])
            name = (prefix + '/' if prefix else '') + leaf
            if not re.fullmatch(rb'[0-7]{1,11}', header[124:136].strip(b' \0')): stop('tar archive size field is invalid')
            size = int(header[124:136].strip(b' \0'),8); kind = header[156:157]
            if kind not in (b'0',b'\0'): stop('archive links and special entries are not allowed')
            if not name or len(name) > 240 or '\\' in name or name.startswith('/'): stop('archive path is invalid')
            parts = name.rstrip('/').split('/')
            if not parts or any(not p or p in ('.','..') or ':' in p or not re.fullmatch(r'[-A-Za-z0-9._+@]+',p) for p in parts): stop('archive path is unsafe')
            if parts[0] != folder or len(parts) < 2: stop('archive root folder mismatch')
            relative_name = '/'.join(parts[1:])
            if not relative_name or relative_name in names: stop('archive contains duplicate paths')
            names.add(relative_name)
            if size > MAX_ENTRY or total + size > MAX_TOTAL: stop('archive expanded size exceeds its bound')
            total += size
            remaining = size
            while remaining:
                block = stream.read(min(1024*1024,remaining))
                if not block: stop('tar archive entry is truncated')
                remaining -= len(block)
            padding = (-size) % 512
            if padding and len(stream.read(padding)) != padding: stop('tar archive padding is truncated')
    if not names: stop('tar archive contains no files')
def write_stream(source, destination, expected_size, hasher, total):
    written = 0
    with open(destination, 'xb') as output:
        while True:
            block = source.read(min(1024*1024, expected_size-written+1))
            if not block: break
            written += len(block); total[0] += len(block)
            if written > expected_size or written > MAX_ENTRY or total[0] > MAX_TOTAL: stop('archive expanded size exceeds its bound')
            hasher.update(block); output.write(block)
    if written != expected_size: stop('archive entry size mismatch')
    return hasher.hexdigest()

stage = None
lock_fd = None
try:
    if os.geteuid() == 0: stop('run as the installing user, not root')
    if not prefix.is_absolute() or any(part in ('.','..') for part in prefix.parts): stop('install prefix must be a normalized absolute path')
    safe_components(prefix)
    writable_anchor = prefix if prefix.exists() else (prefix.parent if prefix.parent.exists() else Path(prefix.anchor))
    if not os.access(writable_anchor, os.W_OK | os.X_OK): stop('install location is not user-writable')
    manifest_bytes, m = json_bytes(manifest_path, 65536)
    if m.get('format') != 1 or m.get('product') != 'Excess Worker' or m.get('repository') != 'https://github.com/excesssh/Excess-Worker': stop('release identity is invalid')
    version, commit, sequence = m.get('version'), m.get('sourceCommit'), m.get('sequence')
    if not semver(version) or not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit) or isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < FLOOR: stop('release version, source, or minimum sequence is invalid')
    files = m.get('files'); isolation = m.get('isolation'); permissions = m.get('permissions')
    if not isinstance(files, list) or len(files) not in (1,2) or not isinstance(isolation, dict) or not isinstance(permissions, dict): stop('release fields are invalid')
    if len({entry.get('platform') for entry in files if isinstance(entry,dict)}) != len(files) or set(isolation) != {entry.get('platform') for entry in files}: stop('release platform list is invalid')
    if any(not isinstance(permissions.get(k),str) or not permissions[k].strip() or len(permissions[k].encode()) > 512 for k in ('filesystem','network','credentials')): stop('release permission fields are invalid')
    entry = next((x for x in files if isinstance(x,dict) and x.get('platform') == platform), None)
    expected_archive = f'excess-worker-{version}-{commit[:12]}-linux-x64.tar.gz'
    if not entry or entry.get('file') != expected_archive or Path(archive_path).name != expected_archive: stop('archive name does not match signed release identity')
    if isinstance(entry.get('bytes'),bool) or entry.get('bytes') != archive_size or not re.fullmatch('[0-9a-f]{64}', str(entry.get('sha256',''))): stop('archive size or digest field is invalid')
    if strict_digest(archive_path) != entry['sha256']: stop('archive SHA-256 mismatch')
    manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
    folder = f'excess-worker-{version}-linux-x64'
    app_name = f'{version}-{commit[:12]}'
    app_parent = prefix / 'app'; bin_dir = prefix / 'bin'; state_dir = prefix / 'state'
    highwater = state_dir / 'release-high-water.json'
    for directory in (app_parent, bin_dir, state_dir): safe_components(directory)
    anchor = prefix
    while not anchor.exists(): anchor = anchor.parent
    if anchor.is_symlink() or not anchor.is_dir(): stop('install path anchor is unsafe')
    stage_root = Path(tempfile.mkdtemp(prefix='.worker-stage-', dir=anchor))
    stage = stage_root / 'app'
    stage.mkdir(mode=0o700)
    seen, hashes, total = set(), {}, [0]
    count = 0
    validate_tar(archive_path,folder)
    with tarfile.open(archive_path, mode='r|gz') as archive:
        for member in archive:
            count += 1
            if count > 4096: stop('archive contains too many entries')
            parts = path_name(member.name)
            if parts[0] != folder: stop('archive root folder mismatch')
            if member.issym() or member.islnk() or member.isdev() or member.isfifo() or not member.isfile(): stop('archive links and special entries are not allowed')
            rel = '/'.join(parts[1:])
            if not rel or rel in seen: stop('archive contains duplicate or root-only entries')
            seen.add(rel)
            if member.size > MAX_ENTRY or member.size < 0 or total[0] + member.size > MAX_TOTAL: stop('archive expanded size exceeds its bound')
            target = stage.joinpath(*parts[1:])
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            stream = archive.extractfile(member)
            if stream is None: stop('archive file could not be read')
            hasher = hashlib.sha256()
            hashes[rel] = write_stream(stream,target,member.size,hasher,total)
            executables = ('excess-worker', 'node/bin/node',
                'app/node_modules/@excess/adapters/native/excess-sandbox',
                'app/node_modules/@excess/adapters/native/excess-controller',
                'app/node_modules/@excess/adapters/native/excess-egress-peer')
            os.chmod(target, 0o755 if rel in executables else 0o600)
    if not {'manifest.json','excess-worker','node/bin/node'}.issubset(seen): stop('archive is missing a required package file')
    sum_path = stage / 'SHA256SUMS.txt'
    if sum_path.exists():
        expected = {}
        for line in sum_path.read_text('utf-8').splitlines():
            match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9._+@/-]+)',line)
            if not match or match.group(2) in expected: stop('package checksum list is invalid')
            expected[match.group(2)] = match.group(1)
        if set(expected) != seen - {'SHA256SUMS.txt'} or any(hashes[p] != value for p,value in expected.items()): stop('package checksum list does not match extracted contents')
    package_bytes, package = json_bytes(stage/'manifest.json',65536)
    if package.get('product') != 'EXCESS' or package.get('package') != 'worker': stop('worker package identity is invalid')
    if package.get('publicDistributionReady') is not True:
        if not verification_candidate or package.get('publicDistributionReady') is not False or package.get('releaseGate') != 'isolated-hardware-execution-pending' or package.get('licensesIncluded') is not True: stop('worker package distribution gate is closed')
        print('Installing a local signed verification candidate. Public release readiness remains closed.')
    if package.get('version') != version or package.get('releaseSequence') != sequence or package.get('sourceCommit') != commit or package.get('platform') != platform: stop('worker package source or platform identity mismatch')
    for path in stage.rglob('*'):
        if path.is_symlink() or (not path.is_file() and not path.is_dir()): stop('staged package contains a link or special entry')
    # Re-read every staged file after writing, before the commit point.
    for rel, expected_hash in hashes.items():
        if strict_digest(stage.joinpath(*rel.split('/'))) != expected_hash: stop('staged package rehash failed')
    for directory in (app_parent, bin_dir, state_dir): directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for directory in (app_parent, bin_dir, state_dir): safe_components(directory)
    lock_path = state_dir / 'install.lock'
    lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    lock_fd = os.open(lock_path, lock_flags, 0o600)
    lock_stat = os.fstat(lock_fd)
    if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.geteuid() or lock_stat.st_nlink != 1: stop('install lock is not a private regular file')
    os.fchmod(lock_fd, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    current = None
    if highwater.exists() or highwater.is_symlink():
        if not regular(highwater): stop('saved release state is not a regular file')
        _, current = json_bytes(highwater, 2048)
        if set(current) not in ({'sequence','version','sourceCommit'}, {'sequence','version','sourceCommit','manifestDigest'}): stop('saved release state is invalid')
        if isinstance(current.get('sequence'),bool) or not isinstance(current.get('sequence'),int) or current['sequence'] < FLOOR or not semver(current.get('version')) or not re.fullmatch('[0-9a-f]{40}',str(current.get('sourceCommit',''))): stop('saved release state is invalid')
        if 'manifestDigest' in current and not re.fullmatch('[0-9a-f]{64}',str(current['manifestDigest'])): stop('saved release state is invalid')
        if sequence < current['sequence']: stop('release sequence rollback rejected')
        if sequence == current['sequence'] and (version != current['version'] or commit != current['sourceCommit'] or current.get('manifestDigest') not in (None,manifest_digest)): stop('release sequence equivocation rejected')
        if sequence > current['sequence'] and compare_versions(version,current['version']) < 0: stop('release version downgrade rejected')
    target = app_parent / app_name
    launcher = bin_dir / 'excess-worker'
    if (launcher.exists() or launcher.is_symlink()) and (not regular(launcher) or 'EXCESS WORKER MANAGED LAUNCHER' not in launcher.read_text('utf-8')): stop('refusing to replace an unmanaged launcher')
    if target.exists() or target.is_symlink():
        if not target.is_dir() or target.is_symlink(): stop('existing version path is unsafe')
        for old in target.rglob('*'):
            if old.is_symlink() or (not old.is_file() and not old.is_dir()): stop('existing version contains a link or special entry')
        old_files = {str(p.relative_to(target)).replace(os.sep,'/'):strict_digest(p) for p in target.rglob('*') if p.is_file()}
        if old_files != hashes: stop('existing version contents differ from signed archive')
        shutil.rmtree(stage)
    else:
        os.replace(stage,target)
    launcher_text = '''#!/bin/sh\n# EXCESS WORKER MANAGED LAUNCHER\nset -eu\nBIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nEXCESS_INSTALL_ROOT=${EXCESS_INSTALL_ROOT:-$(dirname -- "$BIN_DIR")}\nexport EXCESS_INSTALL_ROOT\nexec "$EXCESS_INSTALL_ROOT/app/''' + app_name + '''/excess-worker" "$@"\n'''
    temp_launcher = bin_dir / ('.excess-worker.new-' + next(tempfile._get_candidate_names()))
    temp_state = state_dir / ('.release-state.new-' + next(tempfile._get_candidate_names()))
    try:
        temp_launcher.write_text(launcher_text,encoding='utf-8'); os.chmod(temp_launcher,0o700)
        state = json.dumps({'sequence':sequence,'version':version,'sourceCommit':commit,'manifestDigest':manifest_digest},separators=(',',':'))+'\n'
        temp_state.write_text(state,encoding='utf-8'); os.chmod(temp_state,0o600)
        previous_launcher = launcher.read_bytes() if launcher.exists() else None
        os.replace(temp_launcher,launcher)
        try: os.replace(temp_state,highwater)
        except Exception:
            if previous_launcher is None: launcher.unlink(missing_ok=True)
            else:
                restore = bin_dir / ('.excess-worker.restore-' + next(tempfile._get_candidate_names()))
                restore.write_bytes(previous_launcher); os.chmod(restore,0o700); os.replace(restore,launcher)
            raise
    finally:
        temp_launcher.unlink(missing_ok=True); temp_state.unlink(missing_ok=True)
    print('Verified and installed Excess Worker '+version+' for Linux x64.')
    print('Add "$EXCESS_INSTALL_ROOT/bin" to PATH (or use the full launcher path).')
except Exception as error:
    if stage is not None:
        try: shutil.rmtree(stage.parent if stage.parent.name.startswith('.worker-stage-') else stage,ignore_errors=True)
        except Exception: pass
    message = str(error) if isinstance(error, InstallError) else 'verification or installation failed safely'
    print('EXCESS worker install: '+message,file=sys.stderr)
    sys.exit(1)
finally:
    if lock_fd is not None:
        os.close(lock_fd)
PY
