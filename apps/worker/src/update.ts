/** Authenticated worker updates. Release metadata and package bytes are verified before any install state changes. */
import { createHash, randomUUID } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { scanSafeTarGz, scanSafeZip } from "@excess/adapters";
import { assertReleaseAdvance, parseReleaseManifest, verifyMinisign, type ReleaseManifest, type ReleasePlatform, type ReleaseState } from "@excess/protocol";
import { atomicPrivateJson } from "./control.js";
import { RELEASE_PUBLIC_KEY, RELEASE_SEQUENCE_FLOOR } from "./release-key.js";

export interface UpdateCheck { current: string | null; latest: string; available: boolean; checkedAt: string }
type Fetcher = typeof fetch;
type UpdateTestOptions = {
  origin: string; fetcher?: Fetcher; publicKey: string; platform: ReleasePlatform; stateDir: string;
  current?: ReleaseState | null; sequenceFloor?: number; signal?: AbortSignal;
};
type InstallTestOptions = UpdateTestOptions & { appsDir: string; binDir: string };
type ReleaseEnvelope = { manifest: ReleaseManifest; manifestDigest: string };

const PLATFORM: ReleasePlatform = process.platform === "win32" ? "win32-x64" : "linux-x64";
const RELEASE_STATE_FILE = "release-high-water.json";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const ARCHIVE_LIMITS = { maxInputBytes: MAX_ARCHIVE_BYTES, maxTotalBytes: 1024 * 1024 * 1024, maxEntryBytes: 128 * 1024 * 1024, allowExcessWorkerScope: true };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const releaseId = (state: ReleaseState | null) => state ? state.version + "-" + state.sourceCommit.slice(0, 12) : null;
const validOrigin = (origin: string) => /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(origin);
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function packageRoot(entry: string): string { return resolve(dirname(entry), "..", "..", ".."); }
function validatePackageState(value: unknown): ReleaseState | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.publicDistributionReady !== true || item.product !== "EXCESS" || item.package !== "worker" || !Number.isSafeInteger(item.releaseSequence) || (item.releaseSequence as number) < 1 ||
      typeof item.version !== "string" || !semver.test(item.version) || typeof item.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(item.sourceCommit)) return null;
  return { sequence: item.releaseSequence as number, version: item.version, sourceCommit: item.sourceCommit };
}

function requiresLinuxGpuSandbox(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 2);
}

function verifyGpuPackage(files: ReadonlyMap<string, Buffer>, details: Record<string, unknown>, platform: ReleasePlatform): void {
  const gpu = details.gpu;
  const version = typeof details.version === "string" ? details.version : "";
  if (platform !== "linux-x64") {
    if (gpu !== undefined) throw Error("Linux GPU package metadata is not valid for this platform");
    return;
  }
  if (platform === "linux-x64" && gpu === undefined && !requiresLinuxGpuSandbox(version)) return;
  if (!gpu || typeof gpu !== "object" || Array.isArray(gpu)) throw Error("Linux GPU package integrity metadata is missing");
  const metadata = gpu as Record<string, unknown>;
  const expectedKeys = ["file", "integrityFile", "profile", "sha256", "status"];
  if (Object.keys(metadata).sort().join(",") !== expectedKeys.join(",") ||
      !["linux-cuda-device-budget-v1", "linux-cuda-device-budget-v2"].includes(String(metadata.profile)) ||
      metadata.file !== "app/node_modules/@excess/adapters/native/excess-gpu-sandbox" ||
      metadata.integrityFile !== "app/node_modules/@excess/adapters/native/integrity-gpu.json" ||
      typeof metadata.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.sha256)) {
    throw Error("Linux GPU package integrity metadata is invalid");
  }
  const execution = details.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution) || typeof (execution as Record<string, unknown>).gpuVerified !== "boolean")
    throw Error("Linux GPU package evidence status is missing");
  const gpuVerified = (execution as Record<string, unknown>).gpuVerified === true;
  if ((metadata.status === "verified-configuration-only" && (!gpuVerified || details.publicDistributionReady !== true)) ||
      (metadata.status === "candidate-unverified" && gpuVerified) ||
      !["candidate-unverified", "verified-configuration-only"].includes(String(metadata.status))) {
    throw Error("Linux GPU package claim does not match its recorded evidence");
  }
  const helper = files.get(metadata.file as string), pinBytes = files.get(metadata.integrityFile as string);
  if (!helper || !pinBytes || digest(helper) !== metadata.sha256) throw Error("Linux GPU helper bytes do not match their integrity metadata");
  let pin: unknown;
  try { pin = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pinBytes)); } catch { throw Error("Linux GPU integrity pin is invalid"); }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) throw Error("Linux GPU integrity pin is invalid");
  const value = pin as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "profile,sha256" || value.profile !== metadata.profile || value.sha256 !== metadata.sha256)
    throw Error("Linux GPU helper does not match its integrity pin");
}

/** Current signed-package identity, or null for ordinary source builds (which never self-update). */
export async function currentReleaseState(entry: string = process.argv[1] ?? ""): Promise<ReleaseState | null> {
  if (!entry) return null;
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot(entry), "manifest.json"), "utf8"));
    return validatePackageState(manifest);
  } catch { return null; }
}

/** This package's release ID, or null outside a signed package. */
export async function currentRelease(entry: string = process.argv[1] ?? ""): Promise<string | null> {
  return releaseId(await currentReleaseState(entry));
}

function stateDirectory(): string { return installDirectories(PLATFORM).stateDir; }
function stateFile(directory: string): string { return join(resolve(directory), RELEASE_STATE_FILE); }

async function readHighWater(directory: string): Promise<ReleaseState | null> {
  try {
    const text = await readFile(stateFile(directory), "utf8");
    if (Buffer.byteLength(text, "utf8") > 2048) throw Error("Release state is invalid");
    const value = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(",");
    if (!(["sequence,sourceCommit,version", "manifestDigest,sequence,sourceCommit,version"].includes(keys)) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
        typeof value.version !== "string" || !semver.test(value.version) || typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) throw Error("Release state is invalid");
    if (value.manifestDigest !== undefined && (typeof value.manifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestDigest))) throw Error("Release state is invalid");
    return { sequence: value.sequence as number, version: value.version, sourceCommit: value.sourceCommit, ...(value.manifestDigest ? { manifestDigest: value.manifestDigest } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function boundedResponse(response: Response, maximum: number, label: string): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(label + " download failed"); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) { await response.body.cancel(); throw Error(label + " size exceeds limit"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > maximum) throw Error(label + " size exceeds limit");
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== bytes) throw Error(label + " size mismatch");
  return Buffer.concat(chunks, bytes);
}

function signatureText(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw Error("Release signature is not UTF-8"); }
}

async function fetchReleaseEnvelope(origin: string, fetcher: Fetcher, publicKey: string, signal?: AbortSignal): Promise<ReleaseEnvelope> {
  if (!validOrigin(origin)) throw Error("Updates need the HTTPS exchange this worker is paired with");
  const manifestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const manifestResponse = await fetcher(origin + "/downloads/release.json", { redirect: "error", signal: manifestSignal, cache: "no-store" });
  const bytes = await boundedResponse(manifestResponse, 64 * 1024, "Release manifest");
  const signatureSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const signatureResponse = await fetcher(origin + "/downloads/release.json.minisig", { redirect: "error", signal: signatureSignal, cache: "no-store" });
  const signature = signatureText(await boundedResponse(signatureResponse, 10 * 1024, "Release signature"));
  verifyMinisign(bytes, signature, publicKey);
  return { manifest: parseReleaseManifest(bytes), manifestDigest: digest(bytes) };
}

function selectedFile(manifest: ReleaseManifest, platform: ReleasePlatform) {
  const file = manifest.files.find(item => item.platform === platform);
  if (!file) throw Error("This release does not support this platform");
  if (file.bytes > MAX_ARCHIVE_BYTES) throw Error("Worker archive exceeds the updater limit");
  return file;
}

async function assertReleaseAllowed(manifest: ReleaseManifest, manifestDigest: string, options: Pick<UpdateTestOptions, "stateDir" | "current" | "sequenceFloor">): Promise<void> {
  const floor = options.sequenceFloor ?? RELEASE_SEQUENCE_FLOOR;
  if (!Number.isSafeInteger(floor) || floor < 1 || manifest.sequence < floor) throw Error("Release is below the trusted sequence floor");
  const current = options.current === undefined ? await currentReleaseState() : options.current;
  assertReleaseAdvance(manifest, current, manifestDigest);
  assertReleaseAdvance(manifest, await readHighWater(options.stateDir), manifestDigest);
}

async function fetchAndCheck(options: UpdateTestOptions): Promise<UpdateCheck> {
  const { manifest, manifestDigest } = await fetchReleaseEnvelope(options.origin, options.fetcher ?? fetch, options.publicKey, options.signal);
  selectedFile(manifest, options.platform);
  await assertReleaseAllowed(manifest, manifestDigest, options);
  const currentState = options.current === undefined ? await currentReleaseState() : options.current;
  const current = releaseId(currentState), latest = manifest.version + "-" + manifest.sourceCommit.slice(0, 12);
  return { current, latest, available: current !== null && current !== latest, checkedAt: new Date().toISOString() };
}

async function downloadArchive(origin: string, file: ReleaseManifest["files"][number], fetcher: Fetcher): Promise<Buffer> {
  if (!validOrigin(origin) || file.bytes > MAX_ARCHIVE_BYTES) throw Error("Worker archive is invalid");
  const response = await fetcher(origin + "/downloads/" + file.file, { redirect: "error", signal: AbortSignal.timeout(120000), cache: "no-store" });
  const bytes = await boundedResponse(response, MAX_ARCHIVE_BYTES, "Worker archive");
  if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) throw Error("Worker archive digest or size mismatch");
  return bytes;
}

function archiveFolder(manifest: ReleaseManifest, platform: ReleasePlatform): string {
  return "excess-worker-" + manifest.version + "-" + (platform === "win32-x64" ? "win-x64" : "linux-x64");
}

async function inspectTarLinksAndRoot(archive: Buffer, folder: string): Promise<void> {
  const gunzip = Readable.from([archive]).pipe(createGunzip());
  let pending = Buffer.alloc(0), skip = 0, expanded = 0, root: string | null = null, ended = false;
  try {
    for await (const value of gunzip) {
      const chunk = Buffer.from(value as Buffer); expanded += chunk.length;
      if (expanded > ARCHIVE_LIMITS.maxTotalBytes + 4 * 1024 * 1024) throw Error("Worker tar archive exceeds its expanded limit");
      if (ended) continue;
      let data = chunk;
      if (skip > 0) { const amount = Math.min(skip, data.length); skip -= amount; data = data.subarray(amount); }
      if (data.length) pending = pending.length ? Buffer.concat([pending, data]) : data;
      while (pending.length >= 512) {
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every(byte => byte === 0)) { ended = true; pending = Buffer.alloc(0); break; }
        const nameEnd = header.subarray(0, 100).indexOf(0), name = header.subarray(0, nameEnd < 0 ? 100 : nameEnd).toString("utf8");
        const prefixEnd = header.subarray(345, 500).indexOf(0), prefix = header.subarray(345, prefixEnd < 0 ? 155 : prefixEnd).toString("utf8");
        const full = prefix ? prefix + "/" + name : name, top = full.split("/")[0] ?? "";
        if (!root) root = top;
        if (top !== folder) throw Error("Worker archive root folder mismatch");
        const kind = header[156];
        if (kind === 0x32 || kind === 0x31) throw Error("Worker archive links are not allowed");
        const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
        if (!/^[0-7]{1,11}$/.test(sizeText)) throw Error("Unsafe worker tar archive");
        skip = Math.ceil(parseInt(sizeText, 8) / 512) * 512;
        if (skip > pending.length) { skip -= pending.length; pending = Buffer.alloc(0); break; }
        pending = pending.subarray(skip); skip = 0;
      }
    }
  } catch (error) {
    gunzip.destroy();
    if (error instanceof Error && ["Worker archive links are not allowed", "Worker archive root folder mismatch", "Worker tar archive exceeds its expanded limit"].includes(error.message)) throw error;
    throw Error("Unsafe worker tar archive");
  }
  if (!ended || root !== folder) throw Error("Worker archive root folder mismatch");
}

async function scanArchive(archive: Buffer, manifest: ReleaseManifest, platform: ReleasePlatform): Promise<Map<string, Buffer>> {
  const folder = archiveFolder(manifest, platform), entries: { name: string; data: Buffer }[] = [];
  if (platform === "win32-x64") {
    scanSafeZip(archive, ARCHIVE_LIMITS, entry => entries.push(entry));
    const prefix = folder + "/";
    for (const entry of entries) if (!entry.name.startsWith(prefix)) throw Error("Worker archive root folder mismatch");
  } else {
    await inspectTarLinksAndRoot(archive, folder);
    scanSafeTarGz(archive, ARCHIVE_LIMITS, entry => entries.push(entry));
  }
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const name = platform === "win32-x64" ? entry.name.slice(folder.length + 1) : entry.name, segments = name.split("/");
    if (!name || segments.some(part => !part || part === "." || part === ".." || part.includes(":")) || files.has(name)) throw Error("Unsafe worker archive path");
    files.set(name, entry.data);
  }
  const launcher = platform === "win32-x64" ? "excess-worker.cmd" : "excess-worker";
  const node = platform === "win32-x64" ? "node/node.exe" : "node/bin/node";
  for (const required of ["manifest.json", launcher, node]) if (!files.has(required)) throw Error("Worker archive is missing a required file");
  return files;
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw Error("Worker install path contains a link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function inside(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/")), path = relative(resolve(root), target);
  if (!path || path === ".." || path.startsWith(".." + sep)) throw Error("Worker install path escaped staging directory");
  return target;
}

async function pathExists(path: string): Promise<boolean> { try { await access(path, fsConstants.F_OK); return true; } catch { return false; } }

async function verifyInstalledPackage(root: string, manifest: ReleaseManifest, platform: ReleasePlatform, expectedFiles: ReadonlyMap<string, Buffer>): Promise<void> {
  const details = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Record<string, unknown>, state = validatePackageState(details);
  if (!state || state.version !== manifest.version || state.sequence !== manifest.sequence || state.sourceCommit !== manifest.sourceCommit || details.platform !== platform) throw Error("Existing worker package identity mismatch");
  await assertNoSymlinkComponents(root);
  const seen = new Set<string>();
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? prefix + "/" + entry.name : entry.name, path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Existing worker package contains a link");
      if (entry.isDirectory()) { await walk(path, name); continue; }
      if (!entry.isFile() || !expectedFiles.has(name)) throw Error("Existing worker package file set mismatch");
      const bytes = await readFile(path), expected = expectedFiles.get(name)!;
      if (bytes.byteLength !== expected.byteLength || digest(bytes) !== digest(expected)) throw Error("Existing worker package file mismatch");
      seen.add(name);
    }
  }
  await walk(root);
  if (seen.size !== expectedFiles.size) throw Error("Existing worker package file set mismatch");
}

async function extractRelease(archive: Buffer, manifest: ReleaseManifest, platform: ReleasePlatform, appsDir: string): Promise<string> {
  const files = await scanArchive(archive, manifest, platform), packageBytes = files.get("manifest.json")!;
  if (packageBytes.byteLength > 64 * 1024) throw Error("Packaged worker manifest exceeds limit");
  let packageManifest: unknown;
  try { packageManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes)); } catch { throw Error("Packaged worker manifest is invalid"); }
  const state = validatePackageState(packageManifest), details = packageManifest as Record<string, unknown>;
  if (!state || state.version !== manifest.version || state.sequence !== manifest.sequence || state.sourceCommit !== manifest.sourceCommit || details.platform !== platform) throw Error("Packaged worker identity does not match the signed release");
  verifyGpuPackage(files, details, platform);
  const appName = manifest.version + "-" + manifest.sourceCommit.slice(0, 12), appsRoot = resolve(appsDir), target = join(appsRoot, appName);
  const stage = join(appsRoot, appName + ".new-" + randomUUID());
  await assertNoSymlinkComponents(appsDir);
  await mkdir(appsDir, { recursive: true, mode: 0o700 });
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const [name, data] of files) {
      const destination = inside(stage, name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { flag: "wx", mode: 0o600 });
    }
    if (platform === "linux-x64") {
      await chmod(inside(stage, "excess-worker"), 0o755);
      await chmod(inside(stage, "node/bin/node"), 0o755);
      for (const name of ["excess-sandbox", "excess-gpu-sandbox", "excess-controller", "excess-egress-peer"]) {
        const helper = "app/node_modules/@excess/adapters/native/" + name;
        if (files.has(helper)) await chmod(inside(stage, helper), 0o755);
      }
    }
    let existing: Awaited<ReturnType<typeof lstat>> | null = null;
    try { existing = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing?.isSymbolicLink()) throw Error("Installed worker path is a link");
    if (existing) {
      if (!existing.isDirectory()) throw Error("Installed worker path is not a directory");
      await verifyInstalledPackage(target, manifest, platform, files);
      await rm(stage, { recursive: true, force: true });
    } else await rename(stage, target);
    return appName;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

async function switchLauncher(platform: ReleasePlatform, appName: string, binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(binDir);
  const target = join(resolve(binDir), platform === "win32-x64" ? "excess-worker.cmd" : "excess-worker");
  try { const found = await lstat(target); if (found.isSymbolicLink() || !found.isFile()) throw Error("Worker launcher is not a regular file"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = target + ".new-" + randomUUID();
  const contents = platform === "win32-x64"
    ? "@echo off\r\nrem EXCESS WORKER MANAGED LAUNCHER\r\nsetlocal\r\nif not defined EXCESS_WORKER_INSTALL_ROOT set \"EXCESS_WORKER_INSTALL_ROOT=%LOCALAPPDATA%\\EXCESS\"\r\nif not defined EXCESS_WORKER_HOME set \"EXCESS_WORKER_HOME=%LOCALAPPDATA%\\EXCESS\\worker\"\r\nif not defined EXCESS_MODEL_DIR set \"EXCESS_MODEL_DIR=%LOCALAPPDATA%\\EXCESS\\ai\"\r\ncall \"%EXCESS_WORKER_INSTALL_ROOT%\\app\\" + appName + "\\excess-worker.cmd\" %*\r\nexit /b %ERRORLEVEL%\r\n"
    : "#!/bin/sh\n# EXCESS WORKER MANAGED LAUNCHER\nset -eu\nBIN_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nEXCESS_INSTALL_ROOT=${EXCESS_INSTALL_ROOT:-$(dirname -- \"$BIN_DIR\")}\nexport EXCESS_INSTALL_ROOT\nexec \"$EXCESS_INSTALL_ROOT/app/" + appName + "/excess-worker\" \"$@\"\n";
  await writeFile(temp, contents, { flag: "wx", mode: 0o700 });
  if (platform === "linux-x64") await chmod(temp, 0o755);
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function installVerifiedRelease(options: InstallTestOptions): Promise<void> {
  await mkdir(resolve(options.stateDir), { recursive: true, mode: 0o700 });
  const lockPath = join(resolve(options.stateDir), "release-install.lock"), lock = await open(lockPath, "wx", 0o600);
  try {
    const fetcher = options.fetcher ?? fetch, { manifest, manifestDigest } = await fetchReleaseEnvelope(options.origin, fetcher, options.publicKey);
    await assertReleaseAllowed(manifest, manifestDigest, options);
    const file = selectedFile(manifest, options.platform), archive = await downloadArchive(options.origin, file, fetcher);
    const appName = await extractRelease(archive, manifest, options.platform, options.appsDir);
    const state: ReleaseState = { sequence: manifest.sequence, version: manifest.version, sourceCommit: manifest.sourceCommit, manifestDigest };
    await atomicPrivateJson(stateFile(options.stateDir), state);
    await switchLauncher(options.platform, appName, options.binDir);
  } finally { await lock.close(); await unlink(lockPath); }
}

async function updateCheck(options: Omit<UpdateTestOptions, "publicKey"> & { publicKey?: string }): Promise<UpdateCheck> {
  const resolved: UpdateTestOptions = { ...options, publicKey: options.publicKey ?? RELEASE_PUBLIC_KEY };
  return fetchAndCheck(resolved);
}

export async function checkForUpdate(origin: string, current: string | null, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<UpdateCheck> {
  const packaged = await currentReleaseState();
  // Source builds remain ineligible even when the exchange has a newer signed package.
  void current;
  const resolved: UpdateTestOptions = { origin, fetcher, platform: PLATFORM, stateDir: stateDirectory(), current: packaged, publicKey: RELEASE_PUBLIC_KEY };
  return fetchAndCheck({ ...resolved, ...(signal ? { signal } : {}) });
}

/** Test-only fixture seam for ephemeral signing keys. Production calls keep the trusted key module private and pinned. */
export async function __testCheckForUpdate(options: UpdateTestOptions): Promise<UpdateCheck> { return fetchAndCheck(options); }
/** Test-only fixture seam exercising the same package verification and install path. */
export async function __testInstallRelease(options: InstallTestOptions): Promise<void> { await installVerifiedRelease(options); }

function installDirectories(platform: ReleasePlatform) {
  if (platform === "win32-x64") {
    const local = process.env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local"), root = join(local, "EXCESS");
    const configured = resolve(process.env.EXCESS_WORKER_INSTALL_ROOT ?? root);
    return { appsDir: join(configured, "app"), binDir: join(configured, "bin"), stateDir: join(configured, "state") };
  }
  const data = process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  const root = resolve(process.env.EXCESS_INSTALL_ROOT ?? join(data, "excess"));
  // Installer high-water belongs outside the controller's writable worker
  // state and uses the same root/launcher as both production installers.
  return { appsDir: join(root, "app"), binDir: join(root, "bin"), stateDir: join(root, "state") };
}

/** Download and install a signed worker package. No downloaded script or command is executed. */
export async function runInstaller(origin: string, quiet = false, fetcher: Fetcher = fetch): Promise<number> {
  try {
    const current = await currentReleaseState();
    if (!current) return 1;
    await installVerifiedRelease({ origin, fetcher, platform: PLATFORM, current, publicKey: RELEASE_PUBLIC_KEY, ...installDirectories(PLATFORM) });
    return 0;
  } catch {
    if (!quiet) process.stderr.write("Worker update verification or installation failed.\n");
    return 1;
  }
}

/** Auto-update only where something restarts the worker afterwards: a Linux systemd service. */
export const supervisedBySystemd = () => process.platform === "linux" && typeof process.env.INVOCATION_ID === "string" && process.env.INVOCATION_ID.length > 0;
/** Exit code after installing an update: nonzero, so Restart=on-failure starts the new version. */
export const UPDATED_EXIT_CODE = 75;
