#!/bin/sh
# Local signed-release verification for Linux. This script never installs an archive.
# The public hardware-isolation gate is closed; the manual workflow below stops safely.
# Do not pipe downloaded scripts to a shell. Download release.json, its .minisig, and
# the archive named in the signed manifest, then run this reviewed local verifier.
set -eu

usage() {
  cat <<'TEXT'
Usage: sh install.sh release.json release.json.minisig worker-linux-x64.tar.gz

Manual verification workflow:
  1. Download release.json, release.json.minisig, and the named Linux archive from the same HTTPS /downloads/ directory.
  2. Run this local verifier with those three file paths. It checks the pinned Minisign signature, exact source-bound name,
     size and SHA-256, then refuses extraction while the signed package distribution gate is closed.
TEXT
}
fail() { printf 'EXCESS worker install: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 3 ] || { usage; exit 2; }
manifest=$1 signature=$2 archive=$3
[ "$(uname -s)" = Linux ] || fail 'Linux x64 only.'
case "$(uname -m)" in x86_64|amd64) ;; *) fail 'Linux x64 only.' ;; esac
for tool in minisign python3; do command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required."; done
for file in "$manifest" "$signature" "$archive"; do [ -f "$file" ] || fail 'all three release files must be local files.'; done
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

python3 - "$manifest" "$archive" "$archive_bytes" <<'PY' || fail 'signed manifest or archive identity, size, or digest is invalid.'
import hashlib, json, os, re, sys
path, archive, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
def pairs(items):
    result = {}
    for key, value in items:
        if key in result: raise ValueError()
        result[key] = value
    return result
try:
    with open(path, 'rb') as f: m = json.loads(f.read(65537).decode('utf-8'), object_pairs_hook=pairs)
    assert isinstance(m, dict) and m.get('format') == 1 and m.get('product') == 'Excess Worker'
    assert m.get('repository') == 'https://github.com/excesssh/Excess-Worker'
    version, commit, sequence = m['version'], m['sourceCommit'], m['sequence']
    assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version)
    assert re.fullmatch('[0-9a-f]{40}', commit) and isinstance(sequence, int) and not isinstance(sequence, bool) and sequence > 0
    entries = m['files']; assert isinstance(entries, list) and 1 <= len(entries) <= 2
    platforms = {entry['platform'] for entry in entries}; assert len(platforms) == len(entries) and set(m['isolation']) == platforms
    p = m['permissions']; assert all(isinstance(p[k], str) and p[k].strip() and len(p[k].encode()) <= 512 for k in ('filesystem','network','credentials'))
    entry = next(e for e in entries if e['platform'] == 'linux-x64')
    name = f'excess-worker-{version}-{commit[:12]}-linux-x64.tar.gz'
    assert entry['file'] == name and os.path.basename(archive) == name
    assert entry['bytes'] == size and re.fullmatch('[0-9a-f]{64}', entry['sha256'])
    with open(archive, 'rb') as f: assert hashlib.sha256(f.read(268435457)).hexdigest() == entry['sha256']
except Exception:
    sys.exit(1)
PY

fail 'signature and archive metadata verify, but installation is intentionally unavailable until a reviewed safe bootstrap installer is shipped after isolated hardware gates pass; no files were extracted or changed.'
