import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, cp, link, lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { requiresLinuxGpuSandbox } from "../scripts/public-worker/linux-gpu-package.mjs";

const packageDir = process.env.EXCESS_LINUX_CONTROLLER_PACKAGE_DIR;
const archivePath = process.env.EXCESS_LINUX_CONTROLLER_PACKAGE_ARCHIVE;
const version = JSON.parse(await readFile(new URL("../apps/worker/package.json", import.meta.url), "utf8")).version;
const folder = `excess-worker-${version}-linux-x64`;
const nativeRel = "app/node_modules/@excess/adapters/native/";
const nativeFiles = [
  ["excess-sandbox", "integrity.json", "linux-landlock-v1"],
  ["excess-controller", "integrity-controller.json", "linux-controller-namespaces-v1"],
  ["excess-egress-peer", "integrity-egress-peer.json", "linux-af-unix-peercred-v1"],
  ...(requiresLinuxGpuSandbox(version) ? [["excess-gpu-sandbox", "integrity-gpu.json", "linux-cuda-device-budget-v2"]] : []),
];
const executableFiles = ["excess-worker", "node/bin/node", ...nativeFiles.map(([helper]) => nativeRel + helper)];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function listFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, path));
    else {
      assert.equal(entry.isFile(), true, `unexpected special entry: ${relative(root, path)}`);
      result.push(path);
    }
  }
  return result;
}

async function cloneWithHardlinks(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await cloneWithHardlinks(from, to);
    else {
      assert.equal(entry.isFile(), true);
      await link(from, to);
    }
  }
}

test("Linux controller package pins complete helpers, rejects tampering, and stays closed", async t => {
  if (process.platform !== "linux") return t.skip("requires a Linux package fixture");
  if (!packageDir || !archivePath) return t.skip("neutral Linux package fixture is not configured");

  const root = await import(pathToFileURL(join(packageDir, "app/worker/dist/controller-integrity.js")));
  const { verifyControllerPackage } = root;
  const packageManifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8"));
  assert.equal(packageManifest.platform, "linux-x64");
  assert.equal(packageManifest.publicDistributionReady, false);
  assert.equal(packageManifest.releaseSequence, 3);
  assert.equal(packageManifest.controller.verified, false);
  assert.equal(packageManifest.controller.profile, "linux-controller-namespaces-v1");

  const inventoryText = await readFile(join(packageDir, "SHA256SUMS.txt"), "utf8");
  assert.equal(inventoryText.endsWith("\n"), true);
  const expected = new Map();
  for (const row of inventoryText.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_@+./-]+)$/.exec(row);
    assert.ok(match, "checksum inventory row is canonical");
    assert.equal(expected.has(match[2]), false, "checksum inventory has unique paths");
    expected.set(match[2], match[1]);
  }
  const actualPaths = (await listFiles(packageDir)).map(path => relative(packageDir, path).split(sep).join("/")).filter(path => path !== "SHA256SUMS.txt").sort();
  assert.deepEqual([...expected.keys()].sort(), actualPaths, "checksum inventory covers exactly the complete package tree");
  for (const [path, digest] of expected) assert.equal(sha256(await readFile(join(packageDir, ...path.split("/")))), digest, `hash: ${path}`);

  const nativeNames = (await readdir(join(packageDir, nativeRel))).sort();
  assert.deepEqual(nativeNames, nativeFiles.flatMap(([helper, pin]) => [helper, pin]).sort(), "only the version's required Linux helpers and pins are packaged");
  const manifestControllerFiles = packageManifest.controller.files;
  assert.deepEqual(manifestControllerFiles.map(file => file.file).sort(), [nativeRel + "excess-controller", nativeRel + "excess-egress-peer"].sort());
  for (const [helper, pinFile, profile] of nativeFiles) {
    const bytes = await readFile(join(packageDir, nativeRel, helper));
    const pin = JSON.parse(await readFile(join(packageDir, nativeRel, pinFile), "utf8"));
    assert.deepEqual(Object.keys(pin).sort(), ["profile", "sha256"]);
    assert.equal(pin.profile, profile);
    assert.equal(pin.sha256, sha256(bytes));
    if (helper === "excess-gpu-sandbox") {
      assert.equal(packageManifest.gpu.profile, profile);
      assert.equal(packageManifest.gpu.file, nativeRel + helper);
      assert.equal(packageManifest.gpu.integrityFile, nativeRel + pinFile);
      assert.equal(packageManifest.gpu.sha256, pin.sha256);
      assert.equal(packageManifest.gpu.status, "candidate-unverified");
      assert.equal(packageManifest.execution.gpuVerified, false);
    } else if (helper !== "excess-sandbox") {
      const manifestRecord = manifestControllerFiles.find(file => file.file === nativeRel + helper);
      assert.ok(manifestRecord);
      assert.equal(manifestRecord.profile, profile);
      assert.equal(manifestRecord.sha256, pin.sha256);
    }
  }
  assert.equal(expected.has(nativeRel + "unrelated-native-sentinel"), false);
  await verifyControllerPackage(packageDir);

  const corruptedRoot = await import(pathToFileURL(join(packageDir, "app/worker/dist/controller-integrity.js")));
  const temp = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "excess-linux-package-integrity-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const [helper] of nativeFiles.slice(1)) {
    const missing = join(temp, `missing-${helper}`);
    await cloneWithHardlinks(packageDir, missing);
    await unlink(join(missing, nativeRel, helper));
    await assert.rejects(corruptedRoot.verifyControllerPackage(missing), /CONTROLLER_PACKAGE_INTEGRITY_INVALID/);

    const tampered = join(temp, `tampered-${helper}`);
    await cloneWithHardlinks(packageDir, tampered);
    const target = join(tampered, nativeRel, helper);
    await unlink(target);
    await cp(join(packageDir, nativeRel, helper), target);
    await chmod(target, 0o600);
    await writeFile(target, Buffer.from([0]), { flag: "a" });
    await assert.rejects(corruptedRoot.verifyControllerPackage(tampered), /CONTROLLER_PACKAGE_INTEGRITY_INVALID/);
  }

  const tarListing = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trimEnd().split("\n").sort();
  const expectedArchiveNames = [...expected.keys(), "SHA256SUMS.txt"].map(path => `${folder}/${path}`).sort();
  assert.deepEqual(tarListing, expectedArchiveNames, "archive contains the complete inventoried tree only");
  const tarBytes = gunzipSync(await readFile(archivePath));
  const archiveModes = new Map();
  for (let offset = 0; offset + 512 <= tarBytes.length;) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").split("\0")[0];
    const prefix = field(345, 155), leaf = field(0, 100), name = (prefix ? `${prefix}/` : "") + leaf;
    archiveModes.set(name, Number.parseInt(field(100, 8).trim(), 8));
    const size = Number.parseInt(field(124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const path of executableFiles)
    assert.equal(archiveModes.get(`${folder}/${path}`) & 0o777, 0o755, `${path} has executable archive mode`);
  const extracted = join(temp, "installer-mode-fixture");
  await mkdir(extracted, { mode: 0o700 });
  execFileSync("tar", ["-xzf", archivePath, "-C", extracted, "--no-same-owner", "--no-same-permissions"]);
  const extractedRoot = join(extracted, folder);
  for (const path of await listFiles(extractedRoot)) await chmod(path, 0o600);
  for (const entry of await readdir(extractedRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) await chmod(join(extractedRoot, entry.name), 0o700);
  }
  // Match the installer's explicit executable allowlist for package files.
  for (const path of executableFiles) {
    const file = join(extractedRoot, ...path.split("/"));
    await chmod(file, 0o700);
    await access(file, constants.X_OK);
  }
  for (const [helper] of nativeFiles.slice(1)) assert.ok((await lstat(join(extractedRoot, nativeRel, helper))).mode & 0o111, `${helper} is executable after installer-mode fixture permissions`);

  const config = await import(pathToFileURL(join(packageDir, "app/worker/dist/controller-config.js")));
  const state = join(temp, "missing-config-state");
  await mkdir(state, { mode: 0o700 });
  await assert.rejects(config.configuredControllerOrigin(state, "https://worker.example", Buffer.alloc(48, 0x41).toString("base64")), /CONTROLLER_SETUP_REQUIRED/);

  const budget = await import(pathToFileURL(join(packageDir, "app/worker/dist/controller-budget.js")));
  await assert.rejects(budget.requireControllerBudget(), /CONTROLLER_RESOURCE_BOUNDARY_REQUIRED/);
  const controller = await import(pathToFileURL(join(packageDir, "app/worker/dist/controller.js")));
  await assert.rejects(controller.startLinuxController({ packageDir, installDir: join(temp, "install"), stateDir: state, origin: "https://worker.example" }), /CONTROLLER_RESOURCE_BOUNDARY_REQUIRED/);

  // The package service follows the canonical per-user install wrapper and keeps systemd limits within the native verifier's bounds.
  const service = await import(pathToFileURL(join(packageDir, "app/worker/dist/service.js")));
  const envBefore = process.env.EXCESS_INSTALL_ROOT;
  const prefix = join(temp, "prefix"), wrapper = join(prefix, "bin", "excess-worker");
  await mkdir(join(prefix, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(wrapper, "fixture launcher\n", { mode: 0o700 });
  process.env.EXCESS_INSTALL_ROOT = prefix;
  try {
    assert.equal(await service.launcherPath("/neutral/app/worker/dist/main.js"), wrapper);
  } finally {
    if (envBefore === undefined) delete process.env.EXCESS_INSTALL_ROOT;
    else process.env.EXCESS_INSTALL_ROOT = envBefore;
  }
  const unit = service.userUnit("/neutral/prefix/bin/excess-worker");
  assert.match(unit, /ExecStart="\/neutral\/prefix\/bin\/excess-worker" run/);
  const memory = /^MemoryMax=([0-9]+)M$/m.exec(unit);
  assert.ok(memory);
  assert.ok(Number(memory[1]) >= 256 && Number(memory[1]) <= 12288);
  assert.match(unit, /MemorySwapMax=0/);
  assert.match(unit, /TasksMax=128/);
  assert.match(unit, /CPUQuota=200%/);
});
