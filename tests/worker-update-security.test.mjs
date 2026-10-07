import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { __testCheckForUpdate, __testInstallRelease, runInstaller } from "../apps/worker/dist/update.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";
const current = { sequence: 1, version: "0.1.0", sourceCommit: "a".repeat(40) };
const exists = async path => { try { await access(path); return true; } catch { return false; } };

function signatureFixture(bytes) {
  const keys = generateKeyPairSync("ed25519"), keyId = Buffer.from("1020304050607080", "hex");
  const publicRaw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = "untrusted comment: temporary test key\n" + Buffer.concat([Buffer.from("Ed"), keyId, publicRaw]).toString("base64") + "\n";
  const signature = sign(null, createHash("blake2b512").update(bytes).digest(), keys.privateKey), trusted = "sequence:2 fixture";
  const signatureText = "untrusted comment: temporary test signature\n" + Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64") +
    "\ntrusted comment: " + trusted + "\n" + sign(null, Buffer.concat([signature, Buffer.from(trusted)]), keys.privateKey).toString("base64") + "\n";
  return { publicKey, signatureText };
}

function manifestFor(platform, archive, overrides = {}) {
  const suffix = platform === "win32-x64" ? "win-x64.zip" : "linux-x64.tar.gz";
  const version = overrides.version ?? "1.1.0";
  return {
    format: 1, product: "Excess Worker", version, sequence: 2, sourceCommit: commit,
    repository: "https://github.com/excesssh/Excess-Worker", releasedAt: "2026-10-05T12:00:00Z",
    files: [
      { platform, file: "excess-worker-" + version + "-" + commit.slice(0, 12) + "-" + suffix, bytes: archive.length, sha256: digest(archive), reproducible: true },
      { platform: platform === "win32-x64" ? "linux-x64" : "win32-x64",
        file: "excess-worker-" + version + "-" + commit.slice(0, 12) + "-" + (platform === "win32-x64" ? "linux-x64.tar.gz" : "win-x64.zip"), bytes: 1, sha256: "c".repeat(64), reproducible: false },
    ],
    isolation: { "win32-x64": "fixture-only-profile", "linux-x64": "fixture-only-profile" },
    permissions: { filesystem: "fixture filesystem scope", network: "fixture loopback scope", credentials: "fixture attempt scope" },
    ...overrides,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const [name, dataInput] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), data = Buffer.from(dataInput), crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28); nameBytes.copy(local, 30); data.copy(local, 30 + nameBytes.length);
    localParts.push(local);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46);
    centralParts.push(central); offset += local.length;
  }
  const central = Buffer.concat(centralParts), locals = Buffer.concat(localParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralParts.length, 8); end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(locals.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([locals, central, end]);
}

function tarArchive(folder, entries, { symlink = false } = {}) {
  const blocks = [];
  for (const [name, dataInput] of Object.entries(entries)) {
    const data = Buffer.from(dataInput), path = folder + "/" + name, header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) < 100);
    header.write(path, 0, 100, "utf8"); header.write("0000644\0", 100, 8, "ascii"); header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii"); header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii"); header.fill(0x20, 148, 156); header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (symlink) {
    const header = Buffer.alloc(512), path = folder + "/untrusted-link";
    header.write(path, 0, 100, "utf8"); header.write("0000777\0", 100, 8, "ascii"); header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii"); header.write("00000000000\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii"); header.fill(0x20, 148, 156); header[156] = 0x32;
    header.write("excess-worker", 157, 100, "utf8"); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii"); blocks.push(header);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function packageFiles(platform, sequence = 2, ready = true, options = {}) {
  const version = options.version ?? "1.1.0";
  const manifest = { product: "EXCESS", package: "worker", publicDistributionReady: ready, releaseSequence: sequence, version, sourceCommit: commit, platform,
    execution: { profile: platform === "linux-x64" ? "linux-landlock-v1" : "windows-appcontainer-v1", cpuVerified: ready, gpuVerified: false } };
  const files = platform === "win32-x64"
    ? { "manifest.json": Buffer.alloc(0), "excess-worker.cmd": Buffer.from("@echo off\r\n"), "node/node.exe": Buffer.from("node-fixture"), "app/node_modules/@excess/adapters/dist/index.js":Buffer.from("inert package fixture") }
    : { "manifest.json": Buffer.alloc(0), "excess-worker": Buffer.from("#!/bin/sh\n"), "node/bin/node": Buffer.from("node-fixture"), "app/node_modules/@excess/adapters/dist/index.js":Buffer.from("inert package fixture") };
  if (platform === "linux-x64" && Number(version.split(".")[0]) === 0 && Number(version.split(".")[1]) < 2) {
    // v0.1 package fixtures remain valid without the v0.2 CUDA helper metadata.
  } else if (platform === "linux-x64" && options.gpuMode !== "missing") {
    const helperPath = "app/node_modules/@excess/adapters/native/excess-gpu-sandbox";
    const integrityPath = "app/node_modules/@excess/adapters/native/integrity-gpu.json";
    const helper = Buffer.from("linux gpu helper fixture"), helperHash = digest(helper);
    const pin = options.gpuMode === "pin" ? { profile: "linux-cuda-device-budget-v1", sha256: "f".repeat(64) } : { profile: "linux-cuda-device-budget-v1", sha256: helperHash };
    files[helperPath] = helper;
    files[integrityPath] = Buffer.from(JSON.stringify(pin));
    manifest.gpu = { profile: "linux-cuda-device-budget-v1", file: helperPath, integrityFile: integrityPath, sha256: helperHash,
      status: options.gpuMode === "claim" ? "verified-configuration-only" : "candidate-unverified" };
  }
  const pkg = Buffer.from(JSON.stringify(manifest));
  files["manifest.json"] = pkg;
  return files;
}

function feedFor(platform, archive, overrides = {}) {
  const manifestBytes = Buffer.from(JSON.stringify(manifestFor(platform, archive, overrides))), signed = signatureFixture(manifestBytes), manifest = JSON.parse(manifestBytes);
  const archiveName = manifest.files[0].file, calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.endsWith("/downloads/release.json")) return new Response(manifestBytes);
    if (url.endsWith("/downloads/release.json.minisig")) return new Response(signed.signatureText);
    if (url.endsWith("/downloads/" + archiveName)) return new Response(archive);
    return new Response("missing", { status: 404 });
  };
  return { manifest, manifestBytes, ...signed, fetcher, calls };
}

async function fixtureRoot() {
  const scratchRoot = resolve(process.env.EXCESS_TEST_ROOT ?? ".cache");
  await mkdir(scratchRoot, { recursive: true });
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(scratchRoot, "worker-update-security-")));
  return { root, stateDir: join(root, "state"), appsDir: join(root, "apps"), binDir: join(root, "bin") };
}

test("signed release package installs for Windows and Linux and records only variable based launchers", async () => {
  for (const platform of ["win32-x64", "linux-x64"]) {
    const root = await fixtureRoot();
    try {
      const folder = "excess-worker-1.1.0-" + (platform === "win32-x64" ? "win-x64" : "linux-x64");
      const files = packageFiles(platform);
      const archive = platform === "win32-x64"
        ? zipArchive(Object.fromEntries(Object.entries(files).map(([name, data]) => [folder + "/" + name, data])))
        : tarArchive(folder, files);
      const feed = feedFor(platform, archive);
      await mkdir(root.stateDir, { recursive: true });
      await __testInstallRelease({ origin: "https://fixture.example", fetcher: feed.fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current, appsDir: root.appsDir, binDir: root.binDir });
      const app = join(root.appsDir, "1.1.0-" + commit.slice(0, 12));
      const shim = await readFile(join(root.binDir, platform === "win32-x64" ? "excess-worker.cmd" : "excess-worker"), "utf8");
      const highWater = JSON.parse(await readFile(join(root.stateDir, "release-high-water.json"), "utf8"));
      assert.equal((await readFile(join(app, "manifest.json"), "utf8")).includes(commit), true);
      assert.deepEqual(highWater, { sequence: 2, version: "1.1.0", sourceCommit: commit, manifestDigest: digest(feed.manifestBytes) });
      assert.ok(shim.includes("1.1.0-" + commit.slice(0, 12)));
      assert.equal(shim.includes(root), false, "launcher must not persist a machine specific absolute path");
       if (platform === "linux-x64") {
         const gpuHelper = join(app, "app/node_modules/@excess/adapters/native/excess-gpu-sandbox");
         const gpuPin = join(app, "app/node_modules/@excess/adapters/native/integrity-gpu.json");
         if (process.platform !== "win32") assert.equal((await lstat(gpuHelper)).mode & 0o777, 0o755, "the CUDA helper remains executable after authenticated update installation");
         assert.equal(JSON.parse(await readFile(gpuPin, "utf8")).profile, "linux-cuda-device-budget-v1");
       }
      assert.deepEqual(feed.calls, ["https://fixture.example/downloads/release.json", "https://fixture.example/downloads/release.json.minisig",
        "https://fixture.example/downloads/" + feed.manifest.files[0].file]);
      assert.deepEqual(await readdir(root.appsDir), ["1.1.0-" + commit.slice(0, 12)]);
    } finally { await rm(root.root, { recursive: true, force: true }); }
  }
});

test("legacy v0.1 Linux packages without a CUDA helper remain installable", async () => {
  const root = await fixtureRoot(), platform = "linux-x64", version = "0.1.1", folder = "excess-worker-" + version + "-linux-x64";
  const files = packageFiles(platform, 2, true, { version }), archive = tarArchive(folder, files), feed = feedFor(platform, archive, { version });
  try {
    await __testInstallRelease({ origin: "https://fixture.example", fetcher: feed.fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current, appsDir: root.appsDir, binDir: root.binDir });
    const app = join(root.appsDir, version + "-" + commit.slice(0, 12));
    assert.equal(await exists(join(app, "app/node_modules/@excess/adapters/native/excess-gpu-sandbox")), false);
    assert.equal((await readFile(join(root.binDir, "excess-worker"), "utf8")).includes(version + "-" + commit.slice(0, 12)), true);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("tampered archives, invalid signatures, package identity mismatch, closed release gates, and tar links leave install state untouched", async () => {
  const platform = "linux-x64", folder = "excess-worker-1.1.0-linux-x64", files = packageFiles(platform);
  const goodArchive = tarArchive(folder, files);
  for (const mode of ["hash", "signature", "package", "gate", "link", "gpu-missing", "gpu-pin", "gpu-claim"]) {
    const root = await fixtureRoot();
    try {
      const archive = mode === "gate" ? tarArchive(folder, packageFiles(platform, 2, false)) : mode === "link" ? tarArchive(folder, files, { symlink: true }) :
        mode === "package" ? tarArchive(folder, packageFiles(platform, 3)) : mode.startsWith("gpu-") ? tarArchive(folder, packageFiles(platform, 2, true, { gpuMode: mode.slice(4) })) : goodArchive;
      const feed = feedFor(platform, archive);
      if (mode === "hash") {
        const mismatched = Buffer.from(goodArchive); mismatched[mismatched.length - 5] ^= 1;
        const fetcher = async url => url.endsWith("release.json") ? new Response(feed.manifestBytes) : url.endsWith(".minisig") ? new Response(feed.signatureText)
          : new Response(mismatched);
        await assert.rejects(__testInstallRelease({ origin: "https://fixture.example", fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current, appsDir: root.appsDir, binDir: root.binDir }), /digest or size mismatch/);
      } else {
        const signature = mode === "signature" ? feed.signatureText.replace("sequence:2 fixture", "sequence:2 forged") : feed.signatureText;
        const fetcher = async url => url.endsWith("release.json") ? new Response(feed.manifestBytes) : url.endsWith(".minisig") ? new Response(signature)
          : new Response(archive);
        const matcher = mode === "signature" ? /signature verification failed|trusted comment verification failed/ : (mode === "package" || mode === "gate") ? /identity/ :
          mode.startsWith("gpu-") ? /Linux GPU/ : /links are not allowed/;
        await assert.rejects(__testInstallRelease({ origin: "https://fixture.example", fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current, appsDir: root.appsDir, binDir: root.binDir }), matcher);
      }
      assert.equal(await exists(root.binDir), false, mode + " must not create or change the launcher directory");
      assert.equal(await exists(join(root.stateDir, "release-high-water.json")), false, mode + " must not advance release state");
      assert.equal(await exists(join(root.appsDir, "1.1.0-" + commit.slice(0, 12))), false, mode + " must not install a package");
    } finally { await rm(root.root, { recursive: true, force: true }); }
  }
});

test("rollback and equivocation are rejected against both installed package and persisted high-water state", async () => {
  const root = await fixtureRoot(), platform = "linux-x64", archive = tarArchive("excess-worker-1.1.0-linux-x64", packageFiles(platform)), feed = feedFor(platform, archive);
  try {
    await mkdir(root.stateDir, { recursive: true });
    await writeFile(join(root.stateDir, "release-high-water.json"), JSON.stringify({ sequence: 3, version: "1.3.0", sourceCommit: "c".repeat(40) }));
    await assert.rejects(__testCheckForUpdate({ origin: "https://fixture.example", fetcher: feed.fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current }), /sequence rollback|version downgrade/);
    const sameSequence = feedFor(platform, archive, { sequence: 3 });
    await assert.rejects(__testCheckForUpdate({ origin: "https://fixture.example", fetcher: sameSequence.fetcher, publicKey: sameSequence.publicKey, platform, stateDir: root.stateDir, current }), /equivocation/);
    assert.equal(await readFile(join(root.stateDir, "release-high-water.json"), "utf8"), JSON.stringify({ sequence: 3, version: "1.3.0", sourceCommit: "c".repeat(40) }));
    await writeFile(join(root.stateDir, "release-high-water.json"), JSON.stringify({ sequence: 2, version: "1.1.0", sourceCommit: commit, manifestDigest: "f".repeat(64) }));
    await assert.rejects(__testCheckForUpdate({ origin: "https://fixture.example", fetcher: feed.fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current }), /equivocation/);
    assert.equal(await exists(root.binDir), false);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("an existing versioned directory is fully rehashed before a launcher can point to it", async () => {
  const root = await fixtureRoot(), platform = "linux-x64", folder = "excess-worker-1.1.0-linux-x64", files = packageFiles(platform);
  const archive = tarArchive(folder, files), feed = feedFor(platform, archive), app = join(root.appsDir, "1.1.0-" + commit.slice(0, 12));
  try {
    await mkdir(join(app, "node", "bin"), { recursive: true });
    await writeFile(join(app, "manifest.json"), files["manifest.json"]);
    await writeFile(join(app, "excess-worker"), "tampered launcher");
    await writeFile(join(app, "node", "bin", "node"), files["node/bin/node"]);
    await assert.rejects(__testInstallRelease({ origin: "https://fixture.example", fetcher: feed.fetcher, publicKey: feed.publicKey, platform, stateDir: root.stateDir, current, appsDir: root.appsDir, binDir: root.binDir }), /file mismatch/);
    assert.equal(await readFile(join(app, "excess-worker"), "utf8"), "tampered launcher", "the rejected install leaves the old directory intact");
    assert.equal(await exists(root.binDir), false);
    assert.equal(await exists(join(root.stateDir, "release-high-water.json")), false);
    assert.deepEqual(await readdir(root.appsDir), ["1.1.0-" + commit.slice(0, 12)]);
  } finally { await rm(root.root, { recursive: true, force: true }); }
});

test("source builds are not eligible for production self-update", async () => {
  assert.equal(await runInstaller("https://fixture.example", true), 1);
});
