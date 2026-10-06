import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, lstat, opendir, type FileHandle } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";
import { positivePriceSchema } from "@excess/protocol";
import { DEFAULT_WORKER_POLICY, parseWorkerPolicy, type WorkerPolicy } from "./policy.js";
import { parseWorkerOffers, type WorkerOffer } from "./offer.js";
import type { WorkerMode } from "./control.js";

const POLICY_LIMIT = 4096, CONTROL_LIMIT = 1024, OFFER_LIMIT = 4096, AUTO_PRICE_LIMIT = 4096;
const OWNER_LIMIT = 1024, JOURNAL_LIMIT = 8 * 1024 * 1024, RESULT_LIMIT = 1024 * 1024, ARTIFACT_LIMIT = 32 * 1024 * 1024;
const SNAPSHOT_HANDLES = 4, SNAPSHOT_BYTES = 64 * 1024 * 1024, SNAPSHOT_TTL_MS = 60_000, READ_CHUNK_MAX = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OFFER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const CATALOG_IDS = new Set([...MODEL_CATALOG, ...MEDIA_CATALOG].map(entry => entry.id));
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const blockedMarker = Buffer.from(["aa", "ron"].join("").toLowerCase(), "ascii");
const blockedPatterns = [blockedMarker,
  Buffer.from(Array.from(blockedMarker).flatMap(byte => [byte, 0])),
  Buffer.from(Array.from(blockedMarker).flatMap(byte => [0, byte]))];

function invalid(code = "WORKER_STATE_READ_INVALID"): never { throw new Error(code); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function pathHasLink(path: string): Promise<void> { return assertNoLinks(path); }
async function assertNoLinks(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (isMissing(error)) return; throw error; }
    if (info.isSymbolicLink()) invalid("WORKER_STATE_LINK_REFUSED");
  }
}
function isBlocked(bytes: Uint8Array): boolean {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const pattern of blockedPatterns) {
    if (input.length < pattern.length) continue;
    for (let start = 0; start <= input.length - pattern.length; start++) {
      let match = true;
      for (let offset = 0; offset < pattern.length; offset++) {
        const expected = pattern[offset]!, actual = input[start + offset]!;
        if (expected === 0 ? actual !== 0 : (actual | 0x20) !== (expected | 0x20)) { match = false; break; }
      }
      if (match) return true;
    }
  }
  return false;
}
function createBlockedScanner(): (bytes: Uint8Array) => boolean {
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return bytes => {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), scan = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    const blocked = isBlocked(scan);
    tail = scan.subarray(Math.max(0, scan.length - 9));
    return blocked;
  };
}
function fileLimit(relativeName: string): number {
  if (relativeName === "attempts.jsonl") return JOURNAL_LIMIT;
  if (relativeName === "journal-owner.json") return OWNER_LIMIT;
  if (relativeName.endsWith(".result.json")) return RESULT_LIMIT;
  if (/\.artifact\.[0-9a-f]{64}\.bin$/.test(relativeName)) return ARTIFACT_LIMIT;
  return 0;
}
async function statKey(file: FileHandle): Promise<string> {
  const info = await file.stat({ bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid].join(":");
}
function checkPrivateRoot(info: Awaited<ReturnType<FileHandle["stat"]>>): void {
  if (!info.isDirectory() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (Number(info.mode) & 0o777) !== 0o700))) invalid("WORKER_STATE_ROOT_REFUSED");
}
function checkPrivateFile(info: Awaited<ReturnType<FileHandle["stat"]>>): void {
  if (!info.isFile() || info.nlink !== 1 || (process.platform === "linux" && (info.uid !== process.getuid?.() || (Number(info.mode) & 0o777) !== 0o600))) invalid("WORKER_STATE_FILE_REFUSED");
}
function linuxFdPath(directory: FileHandle, name: string): string { return `/proc/self/fd/${directory.fd}/${name}`; }

type ReaderLimits = { maxHandles: number; maxBytes: number; ttlMs: number };
type ReaderHooks = { afterHashChunk?: () => Promise<void>; afterReadChunk?: () => Promise<void> };
type SnapshotKind = { kind: "journal" } | { kind: "result"; attemptId: string } | { kind: "artifact"; attemptId: string; digest: string };
type SnapshotRecord = { file: FileHandle; id: string; size: number; digest: string; key: string; nextOffset: number; expiresAt: number; busy: boolean; closeRequested: boolean; closeWaiters: Array<() => void> };
export type WorkerStateSnapshotInfo = Readonly<{ id: string; size: number; sha256: string; chunkBytes: number }>;
export interface WorkerStateReader {
  readPolicy(): Promise<WorkerPolicy>;
  readControl(): Promise<WorkerMode>;
  readOffers(modelId?: string): Promise<WorkerOffer[]>;
  readAutoPrices(modelId?: string): Promise<ReadonlyMap<string, string>>;
  readJournalOwner(): Promise<Uint8Array | null>;
  readJournal(): Promise<Uint8Array | null>;
  readResult(attemptId: string): Promise<Uint8Array>;
  readArtifact(attemptId: string, digest: string): Promise<Uint8Array>;
  listOutputs(attemptId: string): Promise<readonly string[]>;
  openSnapshot(request: SnapshotKind, signal?: AbortSignal): Promise<WorkerStateSnapshotInfo>;
  readSnapshot(id: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  closeSnapshot(id: string): Promise<void>;
  close(): Promise<void>;
}
export type WorkerStateReaderOptions = Readonly<{ stateDir: string }>;

async function createReader(options: WorkerStateReaderOptions, limits: ReaderLimits, hooks: ReaderHooks = {}): Promise<WorkerStateReader> {
  if (!options || typeof options.stateDir !== "string" || !options.stateDir) invalid();
  const rootPath = resolve(options.stateDir);
  let rootLstat;
  try { await pathHasLink(rootPath); rootLstat = await lstat(rootPath); } catch (error) { throw fixedError(error); }
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory() || (process.platform === "linux" && (rootLstat.uid !== process.getuid?.() || (rootLstat.mode & 0o777) !== 0o700))) invalid("WORKER_STATE_ROOT_REFUSED");
  let root: FileHandle | undefined;
  try {
    root = await open(rootPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await root.stat(); checkPrivateRoot(opened);
    if (opened.dev !== rootLstat.dev || opened.ino !== rootLstat.ino) invalid("WORKER_STATE_ROOT_CHANGED");
  } catch (error) { await root?.close().catch(() => {}); throw fixedError(error); }
  const rootHandle: FileHandle = root;
  let closed = false, reservedBytes = 0, openingSnapshots = 0, activeOperations = 0, closePromise: Promise<void> | undefined;
  let idleWaiters: Array<() => void> = [];
  const snapshots = new Map<string, SnapshotRecord>();
  const ensureOpen = () => { if (closed) invalid("WORKER_STATE_READER_CLOSED"); };
  const beginOperation = () => {
    ensureOpen(); activeOperations++;
    return () => { activeOperations--; if (activeOperations === 0) for (const resolveIdle of idleWaiters.splice(0)) resolveIdle(); };
  };
  const waitOperations = () => activeOperations === 0 ? Promise.resolve() : new Promise<void>(resolveIdle => idleWaiters.push(resolveIdle));

  const stateParent = async (name: string): Promise<{ path: string; directory: FileHandle; close(): Promise<void> }> => {
    ensureOpen();
    if (name !== "offers") return { path: rootPath, directory: rootHandle, close: async () => {} };
    const path = join(rootPath, "offers");
    await assertNoLinks(path);
    let info;
    try { info = await lstat(path); } catch (error) { throw error; }
    if (info.isSymbolicLink() || !info.isDirectory() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))) invalid("WORKER_STATE_DIRECTORY_REFUSED");
    const directory = await open(process.platform === "linux" ? linuxFdPath(rootHandle, "offers") : path, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory() || (process.platform === "linux" && (opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o700)) || opened.dev !== info.dev || opened.ino !== info.ino) invalid("WORKER_STATE_DIRECTORY_REFUSED");
    } catch (error) { await directory.close(); throw error; }
    return { path, directory, close: () => directory.close() };
  };

  const openSafe = async (relativeName: string): Promise<FileHandle> => {
    const parts = relativeName.split("/");
    if (parts.length < 1 || parts.length > 2 || parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) invalid();
    const parent = parts.length === 2 ? await stateParent(parts[0]!) : await stateParent("");
    const path = parts.length === 2 ? join(parent.path, parts[1]!) : join(parent.path, parts[0]!);
    try {
      await assertNoLinks(path);
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile()) invalid("WORKER_STATE_FILE_REFUSED");
      const filename = parts.at(-1)!;
      const handle = await open(process.platform === "linux" ? linuxFdPath(parent.directory, filename) : path, fsConstants.O_RDONLY | NOFOLLOW);
      try {
        const after = await handle.stat();
        checkPrivateFile(after);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.size < 0) invalid("WORKER_STATE_FILE_CHANGED");
        return handle;
      } catch (error) { await handle.close(); throw error; }
    } finally { await parent.close(); }
  };

  const readFile = async (relativeName: string, maximum: number, optional: boolean): Promise<Buffer | null> => {
    const endOperation = beginOperation();
    let file: FileHandle | undefined;
    try {
      try { file = await openSafe(relativeName); } catch (error) { if (optional && isMissing(error)) return null; throw fixedError(error); }
      ensureOpen();
      const before = await file.stat(); checkPrivateFile(before);
      if (before.size > maximum) invalid("WORKER_STATE_FILE_TOO_LARGE");
      const beforeKey = await statKey(file);
      const data = Buffer.alloc(before.size); let offset = 0;
      while (offset < data.byteLength) {
        const { bytesRead } = await file.read(data, offset, data.byteLength - offset, offset);
        if (!bytesRead) invalid("WORKER_STATE_FILE_CHANGED");
        offset += bytesRead;
      }
      const after = await file.stat();
      if (beforeKey !== await statKey(file) || after.size !== data.byteLength) invalid("WORKER_STATE_FILE_CHANGED");
      if (isBlocked(data)) invalid("WORKER_STATE_BLOCKED_CONTENT");
      return data;
    } catch (error) { throw fixedError(error); }
    finally { await file?.close().catch(() => {}); endOperation(); }
  };

  const selectedModel = (modelId: string) => { if (!CATALOG_IDS.has(modelId)) invalid("WORKER_STATE_MODEL_INVALID"); return modelId; };
  const readModelJson = async (modelId: string, suffix: string): Promise<Buffer | null> => {
    const id = selectedModel(modelId), name = `offers/${id}${suffix}`;
    return readFile(name, suffix === ".json" ? OFFER_LIMIT : AUTO_PRICE_LIMIT, true);
  };
  const mode = async (): Promise<WorkerMode> => {
    const bytes = await readFile("control.json", CONTROL_LIMIT, true);
    if (!bytes) return "stop";
    try {
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "mode,version" || value.version !== 1 || !["run", "drain", "stop"].includes(String(value.mode))) invalid("WORKER_CONTROL_INVALID");
      return value.mode as WorkerMode;
    } catch { invalid("WORKER_CONTROL_INVALID"); }
  };
  const openSelected = (request: SnapshotKind): { name: string; maximum: number } => {
    if (!request || typeof request !== "object" || Array.isArray(request)) invalid("WORKER_SNAPSHOT_REQUEST_INVALID");
    if (request.kind === "journal" && Object.keys(request).sort().join(",") === "kind") return { name: "attempts.jsonl", maximum: JOURNAL_LIMIT };
    if (request.kind === "result" && Object.keys(request).sort().join(",") === "attemptId,kind" && typeof request.attemptId === "string" && UUID.test(request.attemptId))
      return { name: `${request.attemptId}.result.json`, maximum: RESULT_LIMIT };
    if (request.kind === "artifact" && Object.keys(request).sort().join(",") === "attemptId,digest,kind" && typeof request.attemptId === "string" && UUID.test(request.attemptId) && typeof request.digest === "string" && HEX_SHA256.test(request.digest))
      return { name: `${request.attemptId}.artifact.${request.digest}.bin`, maximum: ARTIFACT_LIMIT };
    invalid("WORKER_SNAPSHOT_REQUEST_INVALID");
  };

  const reader: WorkerStateReader = {
    async readPolicy() {
      const data = await readFile("policy.json", POLICY_LIMIT, true);
      if (!data) return { ...DEFAULT_WORKER_POLICY };
      try { return parseWorkerPolicy(JSON.parse(data.toString("utf8"))); } catch { invalid("WORKER_POLICY_INVALID"); }
    },
    readControl: mode,
    async readOffers(modelId = DEFAULT_MODEL_ID) {
      const data = await readModelJson(modelId, ".json");
      if (!data) return [];
      try { return parseWorkerOffers(JSON.parse(data.toString("utf8"))); } catch { invalid("WORKER_OFFER_INVALID"); }
    },
    async readAutoPrices(modelId = DEFAULT_MODEL_ID) {
      const data = await readModelJson(modelId, ".auto.json");
      if (!data) return new Map();
      try {
        const value = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !("prices" in value) || !value.prices || typeof value.prices !== "object" || Array.isArray(value.prices)) invalid("WORKER_AUTO_PRICE_INVALID");
        const entries = Object.entries(value.prices as Record<string, unknown>);
        if (entries.length > 8 || entries.some(([asset, price]) => !OFFER_UUID.test(asset) || typeof price !== "string" || price.length > 40 || !positivePriceSchema.safeParse(price).success)) invalid("WORKER_AUTO_PRICE_INVALID");
        return new Map(entries as [string, string][]);
      } catch { invalid("WORKER_AUTO_PRICE_INVALID"); }
    },
    readJournalOwner: async () => await readFile("journal-owner.json", OWNER_LIMIT, true),
    readJournal: async () => await readFile("attempts.jsonl", JOURNAL_LIMIT, true),
    async readResult(attemptId) {
      if (typeof attemptId !== "string" || !UUID.test(attemptId)) invalid("WORKER_ATTEMPT_ID_INVALID");
      const data = await readFile(`${attemptId}.result.json`, RESULT_LIMIT, false); return data!;
    },
    async readArtifact(attemptId, digest) {
      if (typeof attemptId !== "string" || !UUID.test(attemptId) || typeof digest !== "string" || !HEX_SHA256.test(digest)) invalid("WORKER_OUTPUT_ID_INVALID");
      const data = await readFile(`${attemptId}.artifact.${digest}.bin`, ARTIFACT_LIMIT, false); return data!;
    },
    async listOutputs(attemptId) {
      if (typeof attemptId !== "string" || !UUID.test(attemptId)) invalid("WORKER_ATTEMPT_ID_INVALID");
      const endOperation = beginOperation();
      try {
        const candidates: string[] = [];
        let directory;
        try {
          directory = await opendir(process.platform === "linux" ? `/proc/self/fd/${rootHandle.fd}` : rootPath);
          let scanned = 0;
          for await (const entry of directory) {
            if (++scanned > 10_000) invalid("WORKER_STATE_DIRECTORY_TOO_LARGE");
            const name = entry.name;
            if (name === `${attemptId}.result.json` || new RegExp(`^${attemptId}\\.artifact\\.[0-9a-f]{64}\\.bin$`).test(name)) candidates.push(name);
            if (candidates.length > 512) invalid("WORKER_STATE_OUTPUT_LIMIT");
          }
        } catch (error) { throw fixedError(error); }
        for (const name of candidates) {
          const maximum = fileLimit(name);
          let file: FileHandle;
          try { file = await openSafe(name); } catch (error) { throw fixedError(error); }
          try {
            const before = await file.stat(); checkPrivateFile(before);
            if (!maximum || before.size > maximum) invalid("WORKER_STATE_FILE_TOO_LARGE");
            const beforeKey = await statKey(file);
            if (beforeKey !== await statKey(file)) invalid("WORKER_STATE_FILE_CHANGED");
          } catch (error) { throw fixedError(error); }
          finally { await file.close(); }
        }
        ensureOpen(); return Object.freeze(candidates.sort());
      } finally { endOperation(); }
    },
    async openSnapshot(request, signal) {
      ensureOpen();
      if (signal?.aborted) invalid("WORKER_SNAPSHOT_ABORTED");
      if (snapshots.size + openingSnapshots >= limits.maxHandles) invalid("WORKER_SNAPSHOT_LIMIT");
      const selected = openSelected(request), name = selected.name;
      const endOperation = beginOperation();
      const operationDeadline = Date.now() + limits.ttlMs;
      openingSnapshots++;
      let file: FileHandle | undefined;
      let reserved = 0, registered = false;
      try {
        file = await openSafe(name);
        ensureOpen();
        if (signal?.aborted) invalid("WORKER_SNAPSHOT_ABORTED");
        const before = await file.stat(); checkPrivateFile(before);
        if (before.size > selected.maximum || before.size > limits.maxBytes) invalid("WORKER_SNAPSHOT_LIMIT");
        if (reservedBytes + before.size > limits.maxBytes) invalid("WORKER_SNAPSHOT_LIMIT");
        reservedBytes += before.size; reserved = before.size;
        const key = await statKey(file), hash = createHash("sha256"), buffer = Buffer.alloc(READ_CHUNK_MAX);
        let offset = 0;
        const scanBlocked = createBlockedScanner();
        while (offset < before.size) {
          if (signal?.aborted) invalid("WORKER_SNAPSHOT_ABORTED");
          const length = Math.min(buffer.byteLength, before.size - offset), { bytesRead } = await file.read(buffer, 0, length, offset);
          if (!bytesRead) invalid("WORKER_STATE_FILE_CHANGED");
          const chunk = buffer.subarray(0, bytesRead);
          if (scanBlocked(chunk)) invalid("WORKER_STATE_BLOCKED_CONTENT");
          hash.update(chunk); offset += bytesRead;
          await hooks.afterHashChunk?.();
          ensureOpen();
          if (Date.now() >= operationDeadline) invalid("WORKER_SNAPSHOT_EXPIRED");
        }
        if (key !== await statKey(file) || offset !== before.size) invalid("WORKER_STATE_FILE_CHANGED");
        if (signal?.aborted) invalid("WORKER_SNAPSHOT_ABORTED");
        ensureOpen();
        if (Date.now() >= operationDeadline) invalid("WORKER_SNAPSHOT_EXPIRED");
        const id = randomUUID(), record: SnapshotRecord = { file, id, size: before.size, digest: hash.digest("hex"), key, nextOffset: 0,
          expiresAt: operationDeadline, busy: false, closeRequested: false, closeWaiters: [] };
        snapshots.set(id, record); registered = true; reserved = -1;
        return Object.freeze({ id, size: record.size, sha256: record.digest, chunkBytes: READ_CHUNK_MAX });
      } catch (error) { throw fixedError(error); }
      finally {
        openingSnapshots--;
        if (reserved >= 0) reservedBytes -= reserved;
        if (!registered) await file?.close().catch(() => {});
        endOperation();
      }
    },
    async readSnapshot(id, offset, length, signal) {
      ensureOpen();
      if (typeof id !== "string" || !UUID.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > READ_CHUNK_MAX) invalid("WORKER_SNAPSHOT_REQUEST_INVALID");
      const snapshot = snapshots.get(id);
      if (!snapshot || snapshot.closeRequested) invalid("WORKER_SNAPSHOT_NOT_FOUND");
      const endOperation = beginOperation();
      if (Date.now() >= snapshot.expiresAt) { endOperation(); await closeOne(snapshot); invalid("WORKER_SNAPSHOT_EXPIRED"); }
      if (signal?.aborted) { endOperation(); await closeOne(snapshot); invalid("WORKER_SNAPSHOT_ABORTED"); }
      if (snapshot.busy || offset !== snapshot.nextOffset || offset + length > snapshot.size) { endOperation(); invalid("WORKER_SNAPSHOT_OFFSET_INVALID"); }
      snapshot.busy = true;
      try {
        const before = await snapshot.file.stat();
        if (await statKey(snapshot.file) !== snapshot.key || !before.isFile()) { snapshot.closeRequested = true; invalid("WORKER_STATE_FILE_CHANGED"); }
        const bytes = Buffer.alloc(length); let read = 0;
        while (read < length) {
          if (signal?.aborted) { snapshot.closeRequested = true; invalid("WORKER_SNAPSHOT_ABORTED"); }
          const result = await snapshot.file.read(bytes, read, length - read, offset + read);
          if (!result.bytesRead) { snapshot.closeRequested = true; invalid("WORKER_STATE_FILE_CHANGED"); }
          read += result.bytesRead;
          await hooks.afterReadChunk?.();
        }
        const after = await snapshot.file.stat();
        if (await statKey(snapshot.file) !== snapshot.key || !after.isFile()) { snapshot.closeRequested = true; invalid("WORKER_STATE_FILE_CHANGED"); }
        if (isBlocked(bytes)) { snapshot.closeRequested = true; invalid("WORKER_STATE_BLOCKED_CONTENT"); }
        if (closed || snapshot.closeRequested || signal?.aborted) { snapshot.closeRequested = true; invalid(signal?.aborted ? "WORKER_SNAPSHOT_ABORTED" : "WORKER_STATE_READER_CLOSED"); }
        snapshot.nextOffset += length;
        return bytes;
      } catch (error) { throw fixedError(error); }
      finally { snapshot.busy = false; if (snapshot.closeRequested) await closeOne(snapshot); endOperation(); }
    },
    async closeSnapshot(id) {
      if (typeof id !== "string" || !UUID.test(id)) invalid("WORKER_SNAPSHOT_REQUEST_INVALID");
      const snapshot = snapshots.get(id); if (snapshot) await closeOne(snapshot);
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true; clearInterval(expiryTimer);
      for (const snapshot of snapshots.values()) snapshot.closeRequested = true;
      closePromise = (async () => {
        await waitOperations();
        await Promise.all([...snapshots.values()].map(closeOne));
        await rootHandle.close();
      })();
      return closePromise;
    },
  };

  async function closeOne(snapshot: SnapshotRecord): Promise<void> {
    if (snapshot.busy) { snapshot.closeRequested = true; await new Promise<void>(resolveClose => snapshot.closeWaiters.push(resolveClose)); return; }
    if (snapshots.get(snapshot.id) === snapshot) { snapshots.delete(snapshot.id); reservedBytes -= snapshot.size; }
    await snapshot.file.close().catch(() => {});
    for (const resolveClose of snapshot.closeWaiters.splice(0)) resolveClose();
  }
  const expiryTimer = setInterval(() => {
    const now = Date.now();
    for (const snapshot of snapshots.values()) if (now >= snapshot.expiresAt) void closeOne(snapshot);
  }, Math.max(50, Math.min(5_000, Math.floor(limits.ttlMs / 4))));
  expiryTimer.unref();
  return Object.freeze(reader);
}

function fixedError(error: unknown): Error {
  if (error instanceof Error && /^WORKER_[A-Z0-9_]+$/.test(error.message)) return error;
  if (isMissing(error)) return new Error("ENOENT");
  return new Error("WORKER_STATE_READ_FAILED");
}

export function createWorkerStateReader(options: WorkerStateReaderOptions): Promise<WorkerStateReader> {
  return createReader(options, { maxHandles: SNAPSHOT_HANDLES, maxBytes: SNAPSHOT_BYTES, ttlMs: SNAPSHOT_TTL_MS });
}

/** In-memory guard fixture only; it never writes or logs the supplied bytes. */
export function __testOnlyContainsBlockedChunks(chunks: readonly Uint8Array[]): boolean {
  const scan = createBlockedScanner();
  return chunks.some(chunk => scan(chunk));
}

/** Lower ceilings and short TTL are test-only; they cannot exceed production limits. */
export function __testOnlyCreateWorkerStateReader(options: WorkerStateReaderOptions & { limits: Partial<ReaderLimits>; hooks?: ReaderHooks }): Promise<WorkerStateReader> {
  const limits = { maxHandles: limitsValue(options.limits.maxHandles, SNAPSHOT_HANDLES), maxBytes: limitsValue(options.limits.maxBytes, SNAPSHOT_BYTES),
    ttlMs: limitsValue(options.limits.ttlMs, SNAPSHOT_TTL_MS) };
  if (limits.maxHandles < 1 || limits.maxBytes < 1 || limits.ttlMs < 50) invalid("WORKER_STATE_TEST_LIMIT_INVALID");
  return createReader(options, limits, options.hooks);
}
function limitsValue(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid("WORKER_STATE_TEST_LIMIT_INVALID");
  return value;
}
