import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";

export interface WorkerStateWriter {
  replace(relativeName: string, bytes: Uint8Array): Promise<void>;
  appendJournal(bytes: Uint8Array): Promise<void>;
  removeOutput(relativeName: string): Promise<void>;
  markShutdownUnverified(): Promise<void>;
}
export interface ControllerStateStore extends WorkerStateWriter {
  /** Internal broker fast paths take ownership of the bounded request buffer. */
  replaceFromBroker(relativeName: string, bytes: Buffer): Promise<void>;
  appendJournalFromBroker(bytes: Buffer): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
export interface ControllerStateStoreOptions {
  readonly stateDir: string;
  /** Host-owned runtime-lock callback. It may mark failure but must never release the lock. */
  readonly markShutdownUnverified: () => Promise<void>;
}
export type ControllerStateErrorCode = "CONTROLLER_STATE_INVALID" | "CONTROLLER_STATE_RECOVERY_REQUIRED" |
  "CONTROLLER_STATE_QUOTA_EXCEEDED" | "CONTROLLER_STATE_BLOCKED_CONTENT" | "CONTROLLER_STATE_STORE_CLOSED";

const MAX_FILES = 512, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const JOURNAL_LIMIT = 8 * 1024 * 1024, RESULT_LIMIT = 1024 * 1024, ARTIFACT_LIMIT = 32 * 1024 * 1024;
const STATUS_LIMIT = 16 * 1024, OWNER_LIMIT = 1024, AUTO_PRICE_LIMIT = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODEL_IDS = new Set([...MODEL_CATALOG, ...MEDIA_CATALOG].map(entry => entry.id));
const forbiddenBytes = Buffer.from(["aa", "ron"].join("").toLowerCase(), "ascii");
const forbiddenWideLe = Buffer.from([...forbiddenBytes].flatMap(value => [value, 0]));
const forbiddenWideBe = Buffer.from([...forbiddenBytes].flatMap(value => [0, value]));
type ManagedKind = "status" | "owner" | "journal" | "result" | "artifact" | "auto-price";
type ManagedPath = { kind: ManagedKind; path: string; maximum: number; relativeName: string };
type StoreLimits = { maxFiles: number; maxBytes: number };
const productionLimits = { maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES };
function fail(code: ControllerStateErrorCode): never { throw Error(code); }

function foldAscii(bytes: Uint8Array): Buffer {
  const result = Buffer.from(bytes);
  for (let i = 0; i < result.length; i++) if (result[i]! >= 0x41 && result[i]! <= 0x5a) result[i] = result[i]! + 0x20;
  return result;
}
function containsForbidden(bytes: Uint8Array): boolean {
  const folded = foldAscii(bytes);
  return folded.includes(forbiddenBytes) || folded.includes(forbiddenWideLe) || folded.includes(forbiddenWideBe);
}
function validateLimits(limits: StoreLimits): void {
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || limits.maxFiles > MAX_FILES ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > MAX_TOTAL_BYTES) fail("CONTROLLER_STATE_INVALID");
}
async function assertNoLinks(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) fail("CONTROLLER_STATE_INVALID"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
async function assertPrivateDirectory(path: string): Promise<void> {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (Number(info.mode) & 0o777) !== 0o700))) fail("CONTROLLER_STATE_INVALID");
}
function managedPath(root: string, name: string): ManagedPath {
  if (name === "status.json") return { kind: "status", path: join(root, name), maximum: STATUS_LIMIT, relativeName: name };
  if (name === "journal-owner.json") return { kind: "owner", path: join(root, name), maximum: OWNER_LIMIT, relativeName: name };
  if (name === "attempts.jsonl") return { kind: "journal", path: join(root, name), maximum: JOURNAL_LIMIT, relativeName: name };
  const result = /^([0-9a-f-]{36})\.result\.json$/.exec(name);
  if (result && UUID.test(result[1]!)) return { kind: "result", path: join(root, name), maximum: RESULT_LIMIT, relativeName: name };
  const artifact = /^([0-9a-f-]{36})\.artifact\.([0-9a-f]{64})\.bin$/.exec(name);
  if (artifact && UUID.test(artifact[1]!) && SHA256.test(artifact[2]!)) return { kind: "artifact", path: join(root, name), maximum: ARTIFACT_LIMIT, relativeName: name };
  const price = /^offers\/([A-Za-z0-9._-]{1,128})\.auto\.json$/.exec(name);
  if (price && MODEL_IDS.has(price[1]!)) return { kind: "auto-price", path: join(root, "offers", price[1]! + ".auto.json"), maximum: AUTO_PRICE_LIMIT, relativeName: name };
  fail("CONTROLLER_STATE_INVALID");
}
function validManagedName(name: string): boolean { try { managedPath("", name); return true; } catch { return false; } }
function secureFile(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.isFile() && !info.isSymbolicLink() &&
    (process.platform !== "linux" || (info.uid === process.getuid?.() && (Number(info.mode) & 0o777) === 0o600));
}
async function fileInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { const info = await lstat(path); if (!secureFile(info)) fail("CONTROLLER_STATE_INVALID"); return info; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function scanManaged(root: string, limits: StoreLimits): Promise<{ files: Map<string, number>; bytes: number }> {
  const files = new Map<string, number>(); let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail("CONTROLLER_STATE_INVALID");
    if (entry.name === "offers") {
      const dir = join(root, entry.name), info = await lstat(dir);
      if (!info.isDirectory() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))) fail("CONTROLLER_STATE_INVALID");
      for (const child of await readdir(dir, { withFileTypes: true })) {
        if (child.isSymbolicLink()) fail("CONTROLLER_STATE_INVALID");
        if (/^\.excess-controller-state-stage-[0-9a-f-]{36}\.tmp$/.test(child.name)) fail("CONTROLLER_STATE_RECOVERY_REQUIRED");
        if (!/^[A-Za-z0-9._-]{1,128}\.auto\.json$/.test(child.name)) continue; // regular offers are immutable and host-owned
        const name = `offers/${child.name}`;
        if (!child.isFile() || !validManagedName(name)) fail("CONTROLLER_STATE_INVALID");
        const policy = managedPath(root, name), file = await lstat(policy.path);
        if (!secureFile(file) || file.size > policy.maximum) fail("CONTROLLER_STATE_INVALID");
        files.set(name, file.size); bytes += file.size;
      }
      continue;
    }
    if (/^\.excess-controller-state-stage-[0-9a-f-]{36}\.tmp$/.test(entry.name)) fail("CONTROLLER_STATE_RECOVERY_REQUIRED");
    if (!validManagedName(entry.name)) continue;
    if (!entry.isFile()) fail("CONTROLLER_STATE_INVALID");
    const policy = managedPath(root, entry.name), file = await lstat(policy.path);
    if (!secureFile(file) || file.size > policy.maximum) fail("CONTROLLER_STATE_INVALID");
    files.set(entry.name, file.size); bytes += file.size;
  }
  if (files.size > limits.maxFiles || bytes > limits.maxBytes) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
  return { files, bytes };
}
async function readTail(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!secureFile(info) || info.size > JOURNAL_LIMIT) fail("CONTROLLER_STATE_INVALID");
    const bytes = Math.min(info.size, maximum), result = Buffer.alloc(bytes);
    let read = 0;
    while (read < bytes) {
      const resultRead = await handle.read(result, read, bytes - read, info.size - bytes + read);
      if (!resultRead.bytesRead) fail("CONTROLLER_STATE_INVALID");
      read += resultRead.bytesRead;
    }
    return result;
  } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform !== "linux") return;
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation); tail = current.then(() => undefined, () => undefined); return current;
  };
}
function createStore(options: ControllerStateStoreOptions, limits: StoreLimits): ControllerStateStore {
  const root = resolve(options.stateDir), queue = serialQueue(); let closed = false;
  const ensureOpen = () => { if (closed) fail("CONTROLLER_STATE_STORE_CLOSED"); };
  const withRoot = async <T>(action: () => Promise<T>): Promise<T> => { ensureOpen(); await assertPrivateDirectory(root); return action(); };
  const inspect = () => scanManaged(root, limits);
  const write = async (name: string, bytes: Buffer): Promise<void> => withRoot(async () => {
    const target = managedPath(root, name);
    if (bytes.byteLength > target.maximum) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
    if (containsForbidden(bytes)) fail("CONTROLLER_STATE_BLOCKED_CONTENT");
    const current = await inspect(), oldSize = current.files.get(name);
    if (oldSize === undefined && current.files.size >= limits.maxFiles) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
    // The previous version and complete staged replacement coexist until rename.
    if (current.bytes + bytes.byteLength > limits.maxBytes) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
    await assertNoLinks(target.path);
    const existing = await fileInfo(target.path);
    if ((oldSize === undefined) !== (existing === null)) fail("CONTROLLER_STATE_INVALID");
    if (target.kind === "auto-price") {
      const offers = join(root, "offers");
      try { await mkdir(offers, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(offers);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))) fail("CONTROLLER_STATE_INVALID");
    }
    const temporary = join(dirname(target.path), `.excess-controller-state-stage-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    catch (error) { await file.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); throw error; }
    await file.close();
    try { await rename(temporary, target.path); await syncDirectory(dirname(target.path)); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  });
  const appendJournal = (incoming: Buffer) => queue(() => withRoot(async () => {
        const target = managedPath(root, "attempts.jsonl");
        if (!incoming.byteLength) return;
        if (incoming.byteLength > target.maximum) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
        if (containsForbidden(incoming)) fail("CONTROLLER_STATE_BLOCKED_CONTENT");
        const current = await inspect(), previous = current.files.get(target.relativeName) ?? 0;
        if (previous + incoming.byteLength > target.maximum || current.bytes + incoming.byteLength > limits.maxBytes ||
            (!current.files.has(target.relativeName) && current.files.size >= limits.maxFiles)) fail("CONTROLLER_STATE_QUOTA_EXCEEDED");
        const prior = previous ? await readTail(target.path, forbiddenWideLe.length - 1) : Buffer.alloc(0);
        if (containsForbidden(Buffer.concat([prior, incoming]))) fail("CONTROLLER_STATE_BLOCKED_CONTENT");
        await assertNoLinks(target.path);
        const handle = await open(target.path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        try {
          const info = await handle.stat();
          if (!secureFile(info) || info.size !== previous || info.size + incoming.byteLength > target.maximum) fail("CONTROLLER_STATE_INVALID");
          await handle.writeFile(incoming); await handle.sync();
        } finally { await handle.close(); }
        await syncDirectory(root);
      }));
  const store: ControllerStateStore = {
    replace(name, bytes) { const snapshot = Buffer.from(bytes); return queue(() => write(name, snapshot)); },
    replaceFromBroker(name, bytes) { return queue(() => write(name, bytes)); },
    appendJournal(original) { return appendJournal(Buffer.from(original)); },
    appendJournalFromBroker(bytes) { return appendJournal(bytes); },
    removeOutput(name) {
      return queue(() => withRoot(async () => {
        const target = managedPath(root, name);
        if (target.kind !== "result" && target.kind !== "artifact") fail("CONTROLLER_STATE_INVALID");
        await assertNoLinks(target.path);
        if (await fileInfo(target.path)) { const current = await inspect(); if (!current.files.has(name)) fail("CONTROLLER_STATE_INVALID"); await unlink(target.path); await syncDirectory(root); }
      }));
    },
    markShutdownUnverified() { return queue(() => withRoot(() => options.markShutdownUnverified())); },
    async drain() { await queue(async () => {}); },
    async close() { if (!closed) await queue(async () => { closed = true; }); },
  };
  return Object.freeze(store);
}
export async function createControllerStateStore(options: ControllerStateStoreOptions): Promise<ControllerStateStore> {
  if (!options || typeof options.stateDir !== "string" || !options.stateDir || typeof options.markShutdownUnverified !== "function") fail("CONTROLLER_STATE_INVALID");
  validateLimits(productionLimits);
  const root = resolve(options.stateDir), store = createStore(options, productionLimits);
  await assertPrivateDirectory(root); await scanManaged(root, productionLimits); return store;
}
/** Lower limits are test-only and cannot increase production ceilings. */
export async function __testOnlyCreateControllerStateStore(options: ControllerStateStoreOptions & { limits: StoreLimits }): Promise<ControllerStateStore> {
  validateLimits(options.limits);
  const root = resolve(options.stateDir), store = createStore(options, options.limits);
  await assertPrivateDirectory(root); await scanManaged(root, options.limits); return store;
}
export const __controllerStateStoreLimits = Object.freeze({ maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES,
  statusBytes: STATUS_LIMIT, ownerBytes: OWNER_LIMIT, journalBytes: JOURNAL_LIMIT, resultBytes: RESULT_LIMIT, artifactBytes: ARTIFACT_LIMIT });

export { createLinuxControllerStateBroker } from "./controller-state-client.js";
