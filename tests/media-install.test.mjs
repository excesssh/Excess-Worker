import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, access } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { MEDIA_LIMITS } from "../packages/protocol/dist/index.js";
import { MEDIA_CATALOG, SD_RUNTIME_REDIST, RUNTIME_REDIST, currentPlatform, mediaInstallationPlan, installMediaModel, verifyMediaInstallation, installedComponents,
  sdRuntimeArtifacts, parseWav, toneWav, parsePng } from "../packages/adapters/dist/index.js";
import { installComponent, verifyRuntimeAt } from "../packages/adapters/dist/install.js";
import { readSafeZip, scanSafeZip } from "../packages/adapters/dist/zip.js";

// Tiny ZIP, WAV and PNG fixtures, not runtime evidence.
function fixtureZip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content, mode = 0x8000] of files) {
    const path = Buffer.from(name), body = Buffer.from(content), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(path.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE((mode * 65536) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(local, path, body); central.push(entry, path); offset += local.length + path.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const sha = data => createHash("sha256").update(data).digest("hex");
async function temporary(run) {
  const parent = resolve(".cache"); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(join(parent, "media-install-test-"));
  try { return await run(dir); } finally { assert.equal(dirname(dir), parent); assert.ok(basename(dir).startsWith("media-install-test-")); await rm(dir, { recursive: true, force: true }); }
}

test("media installation plans pick the right runtime, refuse GPU-only models on CPU and pin every file", () => {
  const platform = currentPlatform() ?? "win32-x64";
  for (const entry of MEDIA_CATALOG) {
    const backend = entry.gpuOnly ? (platform === "win32-x64" ? "cuda" : "vulkan") : "cpu";
    const plan = mediaInstallationPlan(".local/media-plan", entry.id, backend);
    assert.deepEqual([plan.modelId, plan.kind, plan.runtime, plan.backend, plan.requiresExplicitConsent], [entry.id, entry.kind, entry.runtime, backend, true]);
    assert.equal(plan.downloadBytes, plan.artifacts.reduce((sum, item) => sum + item.bytes, 0));
    assert.ok(plan.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.url.startsWith("https://")));
    if (entry.runtime === "stable-diffusion.cpp") assert.ok(plan.artifacts.some(item => item.url.includes("leejet/stable-diffusion.cpp/releases/download/master-869-07a85c7/")));
    else assert.ok(plan.artifacts.some(item => item.url.includes("ggml-org/llama.cpp/releases/download/b10809/")));
  }
  assert.throws(() => mediaInstallationPlan(".local/media-plan", "flux1-schnell", "cpu"), /MODEL_REQUIRES_GPU/);
  assert.throws(() => mediaInstallationPlan(".local/media-plan", "qwen3-4b", "cpu"), /UNKNOWN_MODEL/);
  assert.deepEqual(SD_RUNTIME_REDIST.map(item => item.name), [...RUNTIME_REDIST.map(item => item.name), "vcomp140.dll"]);
});

test("media installer requires consent, refuses GPU-only on CPU before touching disk, and detects missing files", async () => temporary(async dir => {
  const root = join(dir, "absent");
  await assert.rejects(installMediaModel(root, { consent: false, modelId: "sd-turbo" }), /MODEL_INSTALL_CONSENT_REQUIRED/);
  await assert.rejects(installMediaModel(root, { consent: true, modelId: "flux1-schnell", backend: "cpu" }), /MODEL_REQUIRES_GPU/);
  await assert.rejects(access(root), { code: "ENOENT" });
  await assert.rejects(verifyMediaInstallation(root, "qwen3-embedding-0.6b"), /ADAPTER_NOT_INSTALLED_OR_CORRUPT|UNSUPPORTED_ADAPTER_PLATFORM/);
  await mkdir(join(dir, "sd-runtimes", "cpu"), { recursive: true }); await writeFile(join(dir, "sd-runtimes", "cpu", "install.json"), "{}");
  await mkdir(join(dir, "models", "sd-turbo"), { recursive: true }); await writeFile(join(dir, "models", "sd-turbo", "install.json"), "{}");
  assert.deepEqual(await installedComponents(dir), { runtimes: [], sdRuntimes: ["cpu"], models: ["sd-turbo"] });
}));

test("reviewed ZIP reader accepts the flat stable-diffusion.cpp layout with Unix modes and still refuses symlink entries", () => {
  const files = readSafeZip(fixtureZip([["libggml-base.so", "FAKE LIB", 0o100755], ["libggml-base.so.0", "FAKE LIB", 0o100755], ["sd-server", "FAKE SERVER", 0o100755], ["stable-diffusion.cpp.txt", "FAKE LICENCE", 0o100644]]));
  assert.deepEqual(files.map(item => item.name), ["libggml-base.so", "libggml-base.so.0", "sd-server", "stable-diffusion.cpp.txt"]);
  assert.throws(() => readSafeZip(fixtureZip([["libggml-base.so.0.19.0", "FAKE LIB", 0o100755], ["libggml-base.so", "libggml-base.so.0.19.0", 0o120777]])), /UNSAFE_RUNTIME_ARCHIVE/);
});

test("the pinned stable-diffusion.cpp zips, when cached locally, hold one server and no links", async t => {
  const cache = resolve(".cache/sd-inspect"), limits = { maxInputBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxEntryBytes: 128 * 1024 * 1024 };
  let checked = 0;
  for (const [platform, backend] of [["win32-x64", "cpu"], ["linux-x64", "cpu"], ["linux-x64", "vulkan"]]) {
    const artifact = sdRuntimeArtifacts(backend, platform)[0], path = join(cache, basename(new URL(artifact.url).pathname));
    let data; try { data = await readFile(path); } catch { continue; }
    assert.equal(sha(data), artifact.sha256, "cached zip matches its pin");
    const names = []; scanSafeZip(data, limits, entry => names.push(entry.name));
    assert.equal(names.filter(name => name === (platform === "win32-x64" ? "sd-server.exe" : "sd-server")).length, 1);
    assert.ok(names.every(name => !name.includes("/")), "flat archive");
    checked++;
  }
  if (!checked) t.skip("stable-diffusion.cpp zips are not cached in .cache/sd-inspect");
});

test("a fixture runtime installs through the offline cache and verification refuses tampered or unexpected files", async t => temporary(async dir => {
  const platform = currentPlatform();
  if (!platform) { t.skip("unsupported platform"); return; }
  const server = platform === "win32-x64" ? "sd-server.exe" : "sd-server";
  const zip = fixtureZip([[server, "FAKE SD SERVER FIXTURE"], [platform === "win32-x64" ? "stable-diffusion.dll" : "libstable-diffusion.so", "FAKE LIBRARY FIXTURE"]]);
  const artifacts = [{ name: "runtime.zip", bytes: zip.length, sha256: sha(zip), url: "https://github.com/fixture/not-downloaded.zip" }];
  await mkdir(join(dir, "downloads"), { recursive: true }); await writeFile(join(dir, "downloads", sha(zip)), zip);
  const spec = { directory: join(dir, "sd-runtimes", "cpu"), artifacts, server, limits: { maxInputBytes: 1 << 20, maxTotalBytes: 1 << 20, maxEntryBytes: 1 << 20 }, redist: SD_RUNTIME_REDIST, platform };
  await installComponent(dir, spec.directory, artifacts, spec.limits, () => verifyRuntimeAt(spec), { backend: "cpu", platform }, AbortSignal.timeout(30000));
  assert.equal(await verifyRuntimeAt(spec), join(spec.directory, "runtime", server));
  assert.deepEqual((await readdir(join(spec.directory, "runtime"))).sort(), [server, platform === "win32-x64" ? "stable-diffusion.dll" : "libstable-diffusion.so"].sort());
  await writeFile(join(spec.directory, "runtime", "unexpected.dll"), "FAKE");
  await assert.rejects(verifyRuntimeAt(spec), /UNEXPECTED_RUNTIME_FILE/);
  await rm(join(spec.directory, "runtime", "unexpected.dll"));
  if (platform === "win32-x64") {
    await writeFile(join(spec.directory, "runtime", "vcomp140.dll"), "NOT THE PINNED OPENMP RUNTIME");
    await assert.rejects(verifyRuntimeAt(spec), /INSTALLED_ARTIFACT_MISMATCH/);
    await rm(join(spec.directory, "runtime", "vcomp140.dll"));
  }
  await writeFile(join(spec.directory, "runtime", server), "TAMPERED FAKE SERVER!!");
  await assert.rejects(verifyRuntimeAt(spec), /INSTALLED_ARTIFACT_MISMATCH/);
}));

test("WAV parser accepts only 16 kHz mono PCM16 between 1 and 300 seconds; PNG check reads the header and trailer", () => {
  const wav = toneWav(1500);
  assert.deepEqual(parseWav(wav), { sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 48000, durationMs: 1500 });
  const withList = Buffer.concat([wav.subarray(0, 12), Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO"), wav.subarray(12)]);
  assert.equal(parseWav(withList).durationMs, 1500);
  const mutate = (offset, write) => { const copy = Buffer.from(wav); write(copy, offset); return copy; };
  for (const bad of [
    mutate(22, (b, o) => b.writeUInt16LE(2, o)), mutate(24, (b, o) => b.writeUInt32LE(44100, o)), mutate(34, (b, o) => b.writeUInt16LE(8, o)),
    mutate(20, (b, o) => b.writeUInt16LE(3, o)), mutate(0, b => b.write("RIFX", 0)), mutate(40, (b, o) => b.writeUInt32LE(0xffffff, o)),
    toneWav(999), toneWav(300001), Buffer.from("not audio"),
  ]) assert.throws(() => parseWav(bad), /INVALID_AUDIO/);
  assert.ok(toneWav(300000).length <= MEDIA_LIMITS.transcription.maxAudioBytes);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 2, 0, 0, 0, 2, 0, 8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
  assert.deepEqual(parsePng(png), { width: 512, height: 512 });
  assert.throws(() => parsePng(png.subarray(0, png.length - 1)), /INVALID_IMAGE_OUTPUT/);
  assert.throws(() => parsePng(png, 10), /INVALID_IMAGE_OUTPUT/);
});
