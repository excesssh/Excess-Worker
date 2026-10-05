import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { verifyMinisign } from "../packages/protocol/dist/release.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const firstCommit = "0123456789abcdef0123456789abcdef01234567";

function createSigner() {
  const keys = generateKeyPairSync("ed25519"), keyId = Buffer.from("1020304050607080", "hex");
  const rawKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = "untrusted comment: temporary Linux fixture key\n" + Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64") + "\n";
  return { publicKey, sign(bytes) {
    const payload = sign(null, createHash("blake2b512").update(bytes).digest(), keys.privateKey), trusted = "sequence:fixture";
    const signature = "untrusted comment: temporary Linux fixture signature\n" + Buffer.concat([Buffer.from("ED"), keyId, payload]).toString("base64") +
      "\ntrusted comment: " + trusted + "\n" + sign(null, Buffer.concat([payload, Buffer.from(trusted)]), keys.privateKey).toString("base64") + "\n";
    verifyMinisign(bytes, signature, publicKey);
    return signature;
  } };
}

function tarArchive(folder, files, symlink = false) {
  const blocks = [];
  function headerFor(path, size, type) {
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) < 100);
    header.write(path, 0, 100, "utf8"); header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii"); header.write("0000000\0", 116, 8, "ascii");
    header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156); header[156] = type; header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    return header;
  }
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body), header = headerFor(`${folder}/${name}`, data.length, 0x30);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (symlink) {
    const header = headerFor(`${folder}/linked`, 0, 0x32);
    header.write("excess-worker", 157, 100, "utf8"); header.fill(0x20, 148, 156);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii"); blocks.push(header);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function makeRelease(archive, { version, commit, sequence }) {
  return Buffer.from(JSON.stringify({
    format: 1, product: "Excess Worker", version, sequence, sourceCommit: commit,
    repository: "https://github.com/excesssh/Excess-Worker", releasedAt: "2026-10-05T12:00:00Z",
    files: [{ platform: "linux-x64", file: `excess-worker-${version}-${commit.slice(0, 12)}-linux-x64.tar.gz`, bytes: archive.length, sha256: digest(archive), reproducible: true }],
    isolation: { "linux-x64": "fixture-only" },
    permissions: { filesystem: "fixture", network: "fixture", credentials: "fixture" },
  }));
}

function packageFiles({ version, commit, sequence, ready = true, packageCommit = commit }) {
  const manifest = Buffer.from(JSON.stringify({ product: "EXCESS", package: "worker", publicDistributionReady: ready,
    releaseSequence: sequence, version, sourceCommit: packageCommit, platform: "linux-x64" }));
  const launcher = ["#!/bin/sh", "set -eu", "DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "exec \"$DIR/node/bin/node\" \"$DIR/app/worker/dist/main.js\" \"$@\"", ""].join("\n");
  const node = ["#!/bin/sh", "printf '%s\\n' \"$@\" > \"$EXCESS_WORKER_TEST_MARKER\"", ""].join("\n");
  return { "manifest.json": manifest, "excess-worker": Buffer.from(launcher), "node/bin/node": Buffer.from(node), "@fixture/package": Buffer.from("scoped archive path") };
}

test("Linux standalone installer executes signed fixture install, upgrade, rollback and rejection cases in WSL", {
  skip: process.platform !== "win32" || process.env.EXCESS_RUN_WSL_INSTALLER_TESTS !== "1",
}, async () => {
  const signer = createSigner(), input = {};
  function add(name, bytes) { input[name] = Buffer.from(bytes).toString("base64"); }
  const installSource = await readFile(new URL("../scripts/worker-install/install.sh", import.meta.url), "utf8");
  const pinnedKey = "untrusted comment: Excess Worker release signing key\nRWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C";
  assert.ok(installSource.includes(pinnedKey), "production shell script keeps its fixed public key");
  add("install.sh", installSource.replace(pinnedKey, signer.publicKey.trimEnd()));

  function addCase(name, archive, release, signature, archiveBytes = archive) {
    const manifest = `cases/${name}/release.json`, sig = `cases/${name}/release.json.minisig`, filename = JSON.parse(release.toString("utf8")).files[0].file;
    add(manifest, release); add(sig, signature); add(`cases/${name}/${filename}`, archiveBytes);
    input[`cases/${name}/filename.txt`] = Buffer.from(filename).toString("base64");
  }
  function signedCase(name, { version = "1.1.0", commit = firstCommit, sequence = 2, ready = true, packageCommit = commit, symlink = false } = {}) {
    const folder = `excess-worker-${version}-linux-x64`, archive = tarArchive(folder, packageFiles({ version, commit, sequence, ready, packageCommit }), symlink);
    const release = makeRelease(archive, { version, commit, sequence }), signature = signer.sign(release);
    addCase(name, archive, release, signature);
    return { archive, release, signature };
  }
  const first = signedCase("first");
  const secondCommit = "abcdef0123456789abcdef0123456789abcdef01";
  signedCase("second", { version: "1.2.0", commit: secondCommit, sequence: 3 });
  const thirdCommit = "1111111123456789abcdef0123456789abcdef01";
  signedCase("third", { version: "1.3.0", commit: thirdCommit, sequence: 4 });
  const fourthCommit = "2222222234567890abcdef0123456789abcdef01";
  signedCase("fourth", { version: "1.4.0", commit: fourthCommit, sequence: 5 });
  addCase("rollback", first.archive, first.release, first.signature);
  const tamper = signedCase("tamper", {}); const altered = Buffer.from(tamper.archive); altered[altered.length - 5] ^= 1;
  addCase("tamper-archive", tamper.archive, tamper.release, tamper.signature, altered);
  const alteredManifest = Buffer.from(first.release); alteredManifest[alteredManifest.indexOf(Buffer.from("1.1.0"))] = 0x32;
  addCase("tamper-manifest", first.archive, alteredManifest, first.signature);
  signedCase("closed", { ready: false });
  signedCase("unsafe", { symlink: true });
  signedCase("identity", { packageCommit: "f".repeat(40) });

  const payload = JSON.stringify(input);
  const wrapper = `set -eu
tools=$(mktemp -d /tmp/excess-worker-linux-installer.XXXXXX)
case "$tools" in /tmp/excess-worker-linux-installer.*) ;; *) exit 90 ;; esac
step=prepare
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "linux-fixture-failed-at:%s:%s\\n" "$step" "$status"; for n in third fourth; do [ ! -f "$tools/status-$n" ] || { printf "status-%s:" "$n"; cat "$tools/status-$n"; }; [ ! -f "$tools/output-$n" ] || grep -F "EXCESS worker install:" "$tools/output-$n" || true; done; fi; case "$tools" in /tmp/excess-worker-linux-installer.*) rm -rf -- "$tools" ;; esac' EXIT HUP INT TERM
cd "$tools"
apt-get download minisign=0.11-1 >/dev/null
expected=854c5f9dddaa99a02915f8cacd41e03442cb6cda25f7bbc53c0a3d297bcd064f
indexed=$(apt-cache show minisign=0.11-1 | sed -n '/^SHA256:/{s/^SHA256: //;p;q;}')
actual=$(sha256sum minisign_0.11-1_amd64.deb | cut -c1-64)
[ "$expected" = "$indexed" ] && [ "$expected" = "$actual" ]
dpkg-deb -x minisign_0.11-1_amd64.deb minisign-root
PATH="$tools/minisign-root/usr/bin:$PATH"; export PATH
minisign -v >/dev/null
export EXCESS_TEST_TOOLS="$tools"
python3 -c 'import base64,json,os,pathlib,sys; root=pathlib.Path(os.environ["EXCESS_TEST_TOOLS"]); data=json.loads(sys.stdin.read()); [(root / name).parent.mkdir(parents=True,exist_ok=True) for name in data]; [(root / name).write_bytes(base64.b64decode(value)) for name,value in data.items()]' <<'PAYLOAD'
${payload}
PAYLOAD
cp "$tools/install.sh" "$tools/install-under-test.sh"
chmod 700 "$tools/install-under-test.sh"
run_ok() { case_name=$1; prefix=$2; case_dir="$tools/cases/$case_name"; filename=$(cat "$case_dir/filename.txt"); EXCESS_INSTALL_ROOT="$prefix" sh "$tools/install-under-test.sh" "$case_dir/release.json" "$case_dir/release.json.minisig" "$case_dir/$filename" --prefix "$prefix" >"$tools/output" 2>&1 || { printf 'fixture-success-failed:%s\n' "$case_name"; exit 1; }; }
run_fail() { case_name=$1; prefix=$2; expected_text=$3; case_dir="$tools/cases/$case_name"; filename=$(cat "$case_dir/filename.txt"); if EXCESS_INSTALL_ROOT="$prefix" sh "$tools/install-under-test.sh" "$case_dir/release.json" "$case_dir/release.json.minisig" "$case_dir/$filename" --prefix "$prefix" >"$tools/output" 2>&1; then printf 'fixture-should-refuse:%s\n' "$case_name"; exit 1; fi; grep -F -q "$expected_text" "$tools/output" || { printf 'fixture-wrong-refusal:%s\n' "$case_name"; exit 1; }; }
prefix="$tools/installed"
step=initial-install
run_ok first "$prefix"
[ -x "$prefix/bin/excess-worker" ] && [ -f "$prefix/app/1.1.0-0123456789ab/manifest.json" ]
run_ok second "$prefix"
[ -f "$prefix/app/1.1.0-0123456789ab/manifest.json" ] && [ -f "$prefix/app/1.2.0-abcdef012345/manifest.json" ]
sequence=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "$prefix/state/release-high-water.json")
[ "$sequence" = 3 ]
EXCESS_WORKER_TEST_MARKER="$tools/launcher-args" EXCESS_INSTALL_ROOT="$prefix" "$prefix/bin/excess-worker" --fixture-launcher-check
grep -F -q -- '--fixture-launcher-check' "$tools/launcher-args"
(
  flock -x "$prefix/state/install.lock" -c "touch '$tools/lock-ready'; while [ ! -f '$tools/release-lock' ]; do sleep 0.05; done"
) &
step=acquire-test-lock
locker=$!
for attempt in $(seq 1 200); do [ -f "$tools/lock-ready" ] && break; sleep 0.05; done
[ -f "$tools/lock-ready" ]
attempt_install() {
  case_name=$1; case_dir="$tools/cases/$case_name"; filename=$(cat "$case_dir/filename.txt")
  if EXCESS_INSTALL_ROOT="$prefix" sh "$tools/install-under-test.sh" "$case_dir/release.json" "$case_dir/release.json.minisig" "$case_dir/$filename" --prefix "$prefix" >"$tools/output-$case_name" 2>&1; then printf installed >"$tools/status-$case_name"
  elif grep -F -q 'release sequence rollback rejected' "$tools/output-$case_name"; then printf rollback-rejected >"$tools/status-$case_name"
  else printf unexpected-refusal >"$tools/status-$case_name"; exit 1; fi
}
attempt_install third & older_pid=$!
attempt_install fourth & newer_pid=$!
step=wait-for-staged-installs
stage_count=0
for attempt in $(seq 1 400); do stage_count=$(find "$prefix" -maxdepth 1 -type d -name '.worker-stage-*' | wc -l | tr -d ' '); [ "$stage_count" -ge 2 ] && break; sleep 0.05; done
[ "$stage_count" -ge 2 ]
sleep 0.2
step=assert-blocked-installs
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "$prefix/state/release-high-water.json")" = 3 ]
grep -F -q '1.2.0-abcdef012345' "$prefix/bin/excess-worker"
touch "$tools/release-lock"
step=await-concurrent-installs
wait "$locker"
wait "$older_pid"
wait "$newer_pid"
grep -F -q installed "$tools/status-fourth"
grep -F -q installed "$tools/status-third" || grep -F -q rollback-rejected "$tools/status-third"
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "$prefix/state/release-high-water.json")" = 5 ]
grep -F -q '1.4.0-222222223456' "$prefix/bin/excess-worker"
step=verify-rejections
before=$(sha256sum "$prefix/state/release-high-water.json" | cut -c1-64)
run_fail rollback "$prefix" 'release sequence rollback rejected'
after=$(sha256sum "$prefix/state/release-high-water.json" | cut -c1-64)
[ "$before" = "$after" ]
run_fail tamper-archive "$tools/tamper-install" 'archive SHA-256 mismatch'
run_fail tamper-manifest "$tools/manifest-install" 'pinned Minisign signature verification failed'
run_fail closed "$tools/closed-install" 'worker package distribution gate is closed'
run_fail unsafe "$tools/unsafe-install" 'archive links and special entries are not allowed'
run_fail identity "$tools/identity-install" 'worker package source or platform identity mismatch'
for name in tamper-install manifest-install closed-install unsafe-install identity-install; do [ ! -e "$tools/$name" ]; done
printf 'Linux WSL bootstrap fixtures passed: install, upgrade, launcher, serialized concurrent installs, rollback, tampering, gate, unsafe tar, identity.\n'
`;
  const result = spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "sh", "-s"], { input: wrapper, encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 });
  const safeDiagnostic = `${result.stdout}\n${result.stderr}`.replace(/(?:[A-Za-z]:\\Users\\)[^\\\s]+/gi, "<home>").replace(/\/mnt\/[a-z]\/Users\/[^/\s]+/gi, "<home>").trim().slice(-500);
  assert.equal(result.status, 0, "WSL native Linux fixture runner completes: " + safeDiagnostic);
});
