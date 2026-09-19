#!/bin/sh
# EXCESS supplier worker installer for Linux x64, served at <exchange>/downloads/install.sh:
#
#   curl -fsSL __EXCESS_ORIGIN__/downloads/install.sh | sh
#
# It downloads the published worker named in latest-linux-x64.txt, checks its SHA-256, unpacks it under
# ~/.local/share/excess/app/<version> and points ~/.local/bin/excess-worker at it. No root, no system changes, nothing
# runs in the background. Running it again installs the newest published version beside the old one and switches to it.
# EXCESS_ORIGIN overrides the exchange; publish-worker.mjs fills in the default for each instance.
set -eu

ORIGIN="${EXCESS_ORIGIN:-__EXCESS_ORIGIN__}"
ORIGIN="${ORIGIN%/}"

say() { printf '%s\n' "$*"; }
fail() { printf 'EXCESS install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux. On Windows, in PowerShell: irm $ORIGIN/downloads/install.ps1 | iex"
case "$(uname -m)" in x86_64 | amd64) ;; *) fail "the worker is built for x86_64 only; this machine is $(uname -m)" ;; esac
case "$ORIGIN" in https://*) ;; *) fail "EXCESS_ORIGIN must be an https:// address" ;; esac
for tool in curl tar sha256sum mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required and was not found"
done
: "${HOME:?HOME is not set}"

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$@"; }

# One line: <archive> <sha256> <bytes> <version> <folder inside the archive>
pointer=$(fetch "$ORIGIN/downloads/latest-linux-x64.txt") || fail "could not read $ORIGIN/downloads/latest-linux-x64.txt"
set -- $pointer
[ "$#" -eq 5 ] || fail "unexpected contents in latest-linux-x64.txt"
archive=$1 sum=$2 bytes=$3 version=$4 folder=$5
printf '%s' "$archive" | grep -Eq '^excess-worker-[A-Za-z0-9._-]+-linux-x64\.tar\.gz$' || fail "unexpected archive name: $archive"
printf '%s' "$sum" | grep -Eq '^[0-9a-f]{64}$' || fail "unexpected checksum: $sum"
printf '%s' "$bytes" | grep -Eq '^[0-9]{1,12}$' || fail "unexpected size: $bytes"
printf '%s' "$version" | grep -Eq '^[A-Za-z0-9._+-]{1,64}$' || fail "unexpected version: $version"
printf '%s' "$folder" | grep -Eq '^excess-worker-[A-Za-z0-9._-]+-linux-x64$' || fail "unexpected folder: $folder"

data="${XDG_DATA_HOME:-$HOME/.local/share}/excess"
apps="$data/app"
bin="$HOME/.local/bin"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

say "Downloading the EXCESS worker $version ($((bytes / 1048576)) MB) from $ORIGIN"
fetch -o "$work/$archive" "$ORIGIN/downloads/$archive" || fail "download failed"
printf '%s  %s\n' "$sum" "$work/$archive" | sha256sum -c - >/dev/null 2>&1 || fail "checksum mismatch; nothing was installed"
tar -xzf "$work/$archive" -C "$work" || fail "could not unpack the archive"
[ -f "$work/$folder/excess-worker" ] || fail "the archive does not contain $folder/excess-worker"
chmod u+x "$work/$folder/excess-worker" "$work/$folder/node/bin/node"

mkdir -p "$apps" "$bin"
rm -rf "$apps/$version.new"
mv "$work/$folder" "$apps/$version.new"
rm -rf "$apps/$version"
mv "$apps/$version.new" "$apps/$version"
# The launcher finds its files relative to itself, so ~/.local/bin gets a small wrapper rather than a symlink.
printf '#!/bin/sh\nexec "%s/excess-worker" "$@"\n' "$apps/$version" > "$bin/excess-worker.new"
chmod 0755 "$bin/excess-worker.new"
mv -f "$bin/excess-worker.new" "$bin/excess-worker"

say "Installed the EXCESS worker $version in $apps/$version"
say "Command: $bin/excess-worker"

missing=""
if command -v ldconfig >/dev/null 2>&1; then libs=$(ldconfig -p 2>/dev/null || true)
elif [ -x /sbin/ldconfig ]; then libs=$(/sbin/ldconfig -p 2>/dev/null || true)
else libs=""; fi
if [ -n "$libs" ] && ! printf '%s' "$libs" | grep -q 'libgomp\.so\.1'; then missing="libgomp1"; fi
if [ -n "$missing" ]; then
  say ""
  say "The model runtime also needs the GNU OpenMP library, which this system does not have yet:"
  if command -v apt-get >/dev/null 2>&1; then say "  sudo apt-get install -y libgomp1"
  elif command -v dnf >/dev/null 2>&1; then say "  sudo dnf install -y libgomp"
  elif command -v zypper >/dev/null 2>&1; then say "  sudo zypper install -y libgomp1"
  elif command -v pacman >/dev/null 2>&1; then say "  sudo pacman -S --needed gcc-libs"
  else say "  install your distribution's libgomp package"; fi
fi

case ":${PATH:-}:" in
  *":$bin:"*) cli="excess-worker" ;;
  *) cli="$bin/excess-worker"; say ""; say "$bin is not on your PATH; use the full path below or add it to PATH." ;;
esac
say ""
say "Next: $cli guide"
say "It shows your next step at any time: choosing a model, pairing with $ORIGIN, setting a price and running."
say "Walkthrough: $ORIGIN/supply"
