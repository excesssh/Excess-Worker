import { createHash, randomUUID } from "node:crypto";
import { MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";
import type { WorkerStateReader, WorkerStateSnapshotInfo } from "./controller-state-reader.js";
import type { WorkerStateWriter } from "./controller-state.js";
import type { WindowsControllerJson } from "./windows-controller.js";
import { parseWorkerPolicy, type WorkerPolicy } from "./policy.js";
import { parseWorkerOffer, type WorkerOffer } from "./offer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const READ_CHUNK = 64 * 1024;
const SNAPSHOT_HANDLES = 4, SNAPSHOT_BYTES = 64 * 1024 * 1024, SNAPSHOT_TTL_MS = 60_000;
const STAGE_HANDLES = 4, STAGE_BYTES = 64 * 1024 * 1024, STAGE_TTL_MS = 30_000;
const CATALOG_IDS = new Set([...MODEL_CATALOG, ...MEDIA_CATALOG].map(entry => entry.id));

type Payload = Readonly<Record<string, WindowsControllerJson>>;
export type WindowsStateCall = (payload: Payload, signal?: AbortSignal) => Promise<WindowsControllerJson>;
export interface WindowsStateHost {
  handle(payload: Payload, signal: AbortSignal): Promise<WindowsControllerJson>;
  close(): Promise<void>;
}
export interface WindowsStateClient {
  readonly reader: WorkerStateReader;
  readonly writer: WorkerStateWriter;
  close(): Promise<void>;
}
type SnapshotRecord = { internalId: string; size: number; sha256: string; nextOffset: number; expiresAt: number; closing: boolean };
type StageRecord = { id: string; name: string; kind: "replace" | "append"; expectedSize: number; buffer: Buffer; offset: number; expiresAt: number };
type HostLimits = { snapshotHandles: number; snapshotBytes: number; snapshotTtlMs: number; stageHandles: number; stageBytes: number; stageTtlMs: number };
type TestHostOptions = { limits?: Partial<HostLimits> };

function fail(): never { throw new Error("WINDOWS_STATE_INVALID"); }
function keys(value: Record<string, unknown>, expected: string): void { if (Object.keys(value).sort().join(",") !== expected) fail(); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(); return value as Record<string, unknown>; }
function fixedJson(value: unknown, max = 256 * 1024): WindowsControllerJson {
  const text = JSON.stringify(value); if (!text || Buffer.byteLength(text, "utf8") > max) fail(); return JSON.parse(text) as WindowsControllerJson;
}
function strictBase64(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) fail();
  return bytes;
}
function managedLimit(name: unknown): number {
  if (typeof name !== "string" || name.length > 180 || name.includes("\\") || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) fail();
  if (name === "status.json") return 16 * 1024;
  if (name === "journal-owner.json") return 1024;
  if (name === "attempts.jsonl") return 8 * 1024 * 1024;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.result\.json$/.test(name)) return 1024 * 1024;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.artifact\.[0-9a-f]{64}\.bin$/.test(name)) return 32 * 1024 * 1024;
  const price = /^offers\/([A-Za-z0-9._-]{1,128})\.auto\.json$/.exec(name);
  if (price && CATALOG_IDS.has(price[1]!)) return 16 * 1024;
  fail();
}
function outputName(value: unknown): value is string {
  return typeof value === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.result\.json$/.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.artifact\.[0-9a-f]{64}\.bin$/.test(value));
}
function snapshotRequest(value: Record<string, unknown>): { kind: "journal" } | { kind: "result"; attemptId: string } | { kind: "artifact"; attemptId: string; digest: string } {
  if (value.kind === "journal") { keys(value, "action,kind"); return { kind: "journal" }; }
  if (value.kind === "result" && typeof value.attemptId === "string" && UUID.test(value.attemptId)) { keys(value, "action,attemptId,kind"); return { kind: "result", attemptId: value.attemptId }; }
  if (value.kind === "artifact" && typeof value.attemptId === "string" && UUID.test(value.attemptId) && typeof value.digest === "string" && SHA256.test(value.digest)) {
    keys(value, "action,attemptId,digest,kind"); return { kind: "artifact", attemptId: value.attemptId, digest: value.digest };
  }
  return fail();
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT" || (error instanceof Error && error.message === "ENOENT"); }

function limits(value: Partial<HostLimits> = {}): HostLimits {
  const bounded = (input: number | undefined, max: number, minimum = 1) => {
    const result = input ?? max; if (!Number.isSafeInteger(result) || result < minimum || result > max) fail(); return result;
  };
  return { snapshotHandles: bounded(value.snapshotHandles, SNAPSHOT_HANDLES), snapshotBytes: bounded(value.snapshotBytes, SNAPSHOT_BYTES),
    snapshotTtlMs: bounded(value.snapshotTtlMs, SNAPSHOT_TTL_MS, 50), stageHandles: bounded(value.stageHandles, STAGE_HANDLES),
    stageBytes: bounded(value.stageBytes, STAGE_BYTES), stageTtlMs: bounded(value.stageTtlMs, STAGE_TTL_MS, 50) };
}

function createHost(reader: WorkerStateReader, writer: WorkerStateWriter, ceiling: HostLimits): WindowsStateHost {
  const snapshots = new Map<string, SnapshotRecord>(), stages = new Map<string, StageRecord>();
  let snapshotBytes = 0, openingSnapshots = 0, stageBytes = 0, stageOperations = 0, closed = false, closePromise: Promise<void> | undefined, activeCalls = 0;
  let idleResolvers: Array<() => void> = [];
  const closeSnapshot = async (token: string): Promise<void> => {
    const item = snapshots.get(token); if (!item || item.closing) return;
    item.closing = true; snapshots.delete(token); snapshotBytes -= item.size;
    await reader.closeSnapshot(item.internalId).catch(() => {});
  };
  const discardStage = (id: string): void => { const item = stages.get(id); if (item) { stages.delete(id); stageBytes -= item.expectedSize; stageOperations--; item.buffer.fill(0); } };
  const takeStage = (id: string): StageRecord | undefined => {
    const item = stages.get(id); if (!item) return undefined;
    stages.delete(id); return item;
  };
  const reap = () => {
    const now = Date.now();
    for (const [token, item] of snapshots) if (now >= item.expiresAt) void closeSnapshot(token);
    for (const [id, item] of stages) if (now >= item.expiresAt) discardStage(id);
  };
  const timer = setInterval(reap, 500); timer.unref();
  const dispatch = async (payload: Payload, signal: AbortSignal): Promise<WindowsControllerJson> => {
    const value = record(payload), action = value.action;
    if (typeof action !== "string") fail();
    if (closed || signal.aborted) {
      if (action === "snapshot-read" && typeof value.id === "string" && UUID.test(value.id)) await closeSnapshot(value.id);
      if (action === "write-chunk" || action === "write-commit") if (typeof value.id === "string" && UUID.test(value.id)) discardStage(value.id);
      fail();
    }
    const throwIfAborted = () => { if (closed || signal.aborted) fail(); };
    if (action === "read-policy") { keys(value, "action"); return fixedJson(await reader.readPolicy()); }
    if (action === "read-control") { keys(value, "action"); return fixedJson(await reader.readControl()); }
    if (action === "read-offers") {
      if (Object.keys(value).sort().join(",") !== ("action" in value && "modelId" in value ? "action,modelId" : "action")) fail();
      if (value.modelId !== undefined && (typeof value.modelId !== "string" || !CATALOG_IDS.has(value.modelId))) fail();
      return fixedJson(await reader.readOffers(value.modelId as string | undefined));
    }
    if (action === "read-auto-prices") {
      if (Object.keys(value).sort().join(",") !== ("modelId" in value ? "action,modelId" : "action")) fail();
      if (value.modelId !== undefined && (typeof value.modelId !== "string" || !CATALOG_IDS.has(value.modelId))) fail();
      return fixedJson([...await reader.readAutoPrices(value.modelId as string | undefined)].map(([asset, price]) => [asset, price]));
    }
    if (action === "read-journal-owner") {
      keys(value, "action"); const bytes = await reader.readJournalOwner(); throwIfAborted();
      return fixedJson({ value: bytes === null ? null : Buffer.from(bytes).toString("base64") });
    }
    if (action === "list-outputs") {
      keys(value, "action,attemptId"); if (typeof value.attemptId !== "string" || !UUID.test(value.attemptId)) fail();
      return fixedJson(await reader.listOutputs(value.attemptId));
    }
    if (action === "snapshot-open") {
      const request = snapshotRequest(value);
      reap(); if (snapshots.size + openingSnapshots >= ceiling.snapshotHandles) fail();
      openingSnapshots++;
      try {
        const info = await reader.openSnapshot(request, signal);
        try {
          throwIfAborted();
          if (info.size > ceiling.snapshotBytes || snapshotBytes + info.size > ceiling.snapshotBytes || info.size < 0 || !SHA256.test(info.sha256)) fail();
        } catch (error) {
          await reader.closeSnapshot(info.id); throw error;
        }
        const token = randomUUID(); snapshots.set(token, { internalId: info.id, size: info.size, sha256: info.sha256,
          nextOffset: 0, expiresAt: Date.now() + ceiling.snapshotTtlMs, closing: false });
        snapshotBytes += info.size;
        const response: WorkerStateSnapshotInfo = { id: token, size: info.size, sha256: info.sha256, chunkBytes: READ_CHUNK };
        return fixedJson(response);
      } catch (error) {
        if (request.kind === "journal" && isMissing(error)) return null;
        throw error;
      } finally { openingSnapshots--; }
    }
    if (action === "snapshot-read") {
      keys(value, "action,id,length,offset");
      if (typeof value.id !== "string" || !UUID.test(value.id) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 ||
          !Number.isSafeInteger(value.length) || Number(value.length) < 1 || Number(value.length) > READ_CHUNK) fail();
      const token = value.id, item = snapshots.get(token);
      if (!item || Date.now() >= item.expiresAt || item.nextOffset !== value.offset || Number(value.offset) + Number(value.length) > item.size) {
        await closeSnapshot(token); fail();
      }
      const onAbort = () => { void closeSnapshot(token); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const bytes = await reader.readSnapshot(item.internalId, Number(value.offset), Number(value.length), signal);
        throwIfAborted();
        item.nextOffset += bytes.byteLength;
        return fixedJson({ bytes: Buffer.from(bytes).toString("base64") });
      } catch (error) { await closeSnapshot(token); throw error; }
      finally { signal.removeEventListener("abort", onAbort); }
    }
    if (action === "snapshot-close") {
      keys(value, "action,id"); if (typeof value.id !== "string" || !UUID.test(value.id)) fail();
      await closeSnapshot(value.id); return fixedJson({ closed: true });
    }
    if (action === "write-begin") {
      if (value.kind !== "replace" && value.kind !== "append") fail();
      const kind = value.kind as "replace" | "append";
      const expected = kind === "append" ? "action,kind,size" : "action,kind,name,size"; keys(value, expected);
      const name = kind === "append" ? "attempts.jsonl" : value.name as string;
      const maximum = managedLimit(name);
      if (kind === "append" && name !== "attempts.jsonl") fail();
      if (!Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > maximum || (Number(value.size) === 0 && name !== "attempts.jsonl")) fail();
      reap(); if (stageOperations >= ceiling.stageHandles || stageBytes + Number(value.size) > ceiling.stageBytes) fail();
      const id = randomUUID(), size = Number(value.size);
      stages.set(id, { id, name, kind, expectedSize: size, buffer: Buffer.alloc(size), offset: 0, expiresAt: Date.now() + ceiling.stageTtlMs });
      stageBytes += size; stageOperations++;
      return fixedJson({ id });
    }
    if (action === "write-chunk") {
      keys(value, "action,bytes,id,offset");
      if (typeof value.id !== "string" || !UUID.test(value.id) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) fail();
      const item = stages.get(value.id); if (!item || Date.now() >= item.expiresAt || value.offset !== item.offset) { discardStage(value.id); fail(); }
      let chunk: Buffer;
      try { chunk = strictBase64(value.bytes, READ_CHUNK); } catch (error) { discardStage(item.id); throw error; }
      if (!chunk.length || item.offset + chunk.length > item.expectedSize) { discardStage(item.id); fail(); }
      chunk.copy(item.buffer, item.offset); item.offset += chunk.length;
      throwIfAborted();
      return fixedJson({ offset: item.offset });
    }
    if (action === "write-commit") {
      keys(value, "action,id"); if (typeof value.id !== "string" || !UUID.test(value.id)) fail();
      const item = stages.get(value.id); if (!item || Date.now() >= item.expiresAt || item.offset !== item.expectedSize) { discardStage(value.id); fail(); }
      const committing = takeStage(value.id)!;
      try {
        throwIfAborted();
        if (committing.kind === "append") await writer.appendJournal(committing.buffer);
        else await writer.replace(committing.name, committing.buffer);
        throwIfAborted(); return fixedJson({ committed: true });
      } finally { stageBytes -= committing.expectedSize; stageOperations--; committing.buffer.fill(0); }
    }
    if (action === "write-cancel") {
      keys(value, "action,id"); if (typeof value.id !== "string" || !UUID.test(value.id)) fail();
      discardStage(value.id); return fixedJson({ cancelled: true });
    }
    if (action === "remove-output") {
      keys(value, "action,name"); if (!outputName(value.name)) fail();
      await writer.removeOutput(value.name); throwIfAborted(); return fixedJson({ removed: true });
    }
    if (action === "mark-shutdown-unverified") {
      keys(value, "action"); await writer.markShutdownUnverified(); throwIfAborted(); return fixedJson({ marked: true });
    }
    return fail();
  };
  const handle: WindowsStateHost["handle"] = async (payload, signal) => {
    if (closed) fail();
    activeCalls++;
    try { return await dispatch(payload, signal); }
    finally { activeCalls--; if (activeCalls === 0) for (const resolveIdle of idleResolvers.splice(0)) resolveIdle(); }
  };
  return Object.freeze({ handle, async close() {
    if (closePromise) return closePromise;
    closed = true; clearInterval(timer);
    closePromise = (async () => {
      for (const id of stages.keys()) discardStage(id);
      await Promise.all([...snapshots.keys()].map(closeSnapshot));
      if (activeCalls) await new Promise<void>(resolveIdle => idleResolvers.push(resolveIdle));
      await reader.close();
    })();
    return closePromise;
  } });
}

export function createWindowsStateHost(reader: WorkerStateReader, writer: WorkerStateWriter): WindowsStateHost {
  return createHost(reader, writer, limits());
}
/** Lower ceilings and short TTL are test-only. */
export function __testOnlyCreateWindowsStateHost(reader: WorkerStateReader, writer: WorkerStateWriter, options: TestHostOptions = {}): WindowsStateHost {
  return createHost(reader, writer, limits(options.limits));
}

function resultRecord(value: unknown, fields: string): Record<string, unknown> { const item = record(value); keys(item, fields); return item; }
function base64Bytes(value: unknown, maximum: number): Uint8Array | null {
  const item = resultRecord(value, "value");
  if (item.value === null) return null;
  return strictBase64(item.value, maximum);
}
function validateSnapshot(value: unknown, maximum: number): WorkerStateSnapshotInfo {
  const item = resultRecord(value, "chunkBytes,id,sha256,size");
  if (typeof item.id !== "string" || !UUID.test(item.id) || !Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > maximum ||
      typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || item.chunkBytes !== READ_CHUNK) fail();
  return item as unknown as WorkerStateSnapshotInfo;
}
function kindMaximum(kind: "journal" | "result" | "artifact"): number { return kind === "journal" ? 8 * 1024 * 1024 : kind === "result" ? 1024 * 1024 : 32 * 1024 * 1024; }
function snapshotPayload(kind: "journal" | "result" | "artifact", attemptId?: string, digest?: string): Payload {
  if (kind === "journal") return { action: "snapshot-open", kind };
  if (!attemptId || !UUID.test(attemptId)) fail();
  if (kind === "result") return { action: "snapshot-open", kind, attemptId };
  if (!digest || !SHA256.test(digest)) fail();
  return { action: "snapshot-open", kind, attemptId, digest };
}
function readCall(call: WindowsStateCall, action: string, extra: Payload = {}): Promise<WindowsControllerJson> { return call({ action, ...extra }); }

export function createWindowsStateClient(call: WindowsStateCall): WindowsStateClient {
  if (typeof call !== "function") fail();
  const open = async (payload: Payload, kind: "journal" | "result" | "artifact", signal?: AbortSignal): Promise<WorkerStateSnapshotInfo | null> => {
    if (closed || clientSnapshots.size + clientOpening >= SNAPSHOT_HANDLES) fail();
    clientOpening++;
    try {
      const value = await call(payload, signal);
      if (kind === "journal" && value === null) return null;
      const info = validateSnapshot(value, kindMaximum(kind));
      if (clientBytes + info.size > SNAPSHOT_BYTES) { await call({ action: "snapshot-close", id: info.id }).catch(() => {}); fail(); }
      clientSnapshots.set(info.id, { info, nextOffset: 0, hash: createHash("sha256"), closing: false }); clientBytes += info.size;
      if (!info.size && info.sha256 !== createHash("sha256").digest("hex")) { await closeSnapshot(info.id); fail(); }
      return info;
    } finally { clientOpening--; }
  };
  type ClientSnapshot = { info: WorkerStateSnapshotInfo; nextOffset: number; hash: ReturnType<typeof createHash>; closing: boolean };
  const clientSnapshots = new Map<string, ClientSnapshot>(); let clientBytes = 0, clientOpening = 0, clientStageBytes = 0, clientStageHandles = 0, closed = false;
  const closeSnapshot = async (id: string): Promise<void> => {
    const item = clientSnapshots.get(id);
    if (item) { clientSnapshots.delete(id); clientBytes -= item.info.size; }
    if (closed) return;
    try { resultRecord(await call({ action: "snapshot-close", id }), "closed"); } catch { /* Cleanup is best effort after transport loss. */ }
  };
  const readSnapshot = async (id: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> => {
    const item = clientSnapshots.get(id);
    if (!item || item.closing || !Number.isSafeInteger(offset) || offset !== item.nextOffset || !Number.isSafeInteger(length) || length < 1 || length > READ_CHUNK || offset + length > item.info.size) fail();
    if (signal?.aborted) { await closeSnapshot(id); fail(); }
    try {
      const response = resultRecord(await call({ action: "snapshot-read", id, offset, length }, signal), "bytes");
      const bytes = strictBase64(response.bytes, READ_CHUNK);
      if (bytes.length !== length) { await closeSnapshot(id); fail(); }
      item.hash.update(bytes); item.nextOffset += bytes.length;
      if (item.nextOffset === item.info.size && item.hash.digest("hex") !== item.info.sha256) { await closeSnapshot(id); fail(); }
      return bytes;
    } catch (error) { await closeSnapshot(id); throw error; }
  };
  const readAll = async (kind: "journal" | "result" | "artifact", attemptId?: string, digest?: string): Promise<Uint8Array | null> => {
    const info = await open(snapshotPayload(kind, attemptId, digest), kind);
    if (!info) return null;
    const output = Buffer.alloc(info.size);
    try {
      let offset = 0;
      while (offset < info.size) { const length = Math.min(READ_CHUNK, info.size - offset), chunk = await readSnapshot(info.id, offset, length); Buffer.from(chunk).copy(output, offset); offset += chunk.length; }
      if (!info.size) { const item = clientSnapshots.get(info.id); if (item && item.hash.digest("hex") !== info.sha256) fail(); }
      return output;
    } finally { await closeSnapshot(info.id); }
  };
  const replaceViaChunks = async (kind: "replace" | "append", name: string, input: Uint8Array): Promise<void> => {
    if (closed) fail();
    const maximum = managedLimit(name), size = input.byteLength;
    if (!Number.isSafeInteger(size) || size > maximum || (size === 0 && name !== "attempts.jsonl") || clientStageHandles >= STAGE_HANDLES || clientStageBytes + size > STAGE_BYTES) fail();
    clientStageHandles++; clientStageBytes += size;
    const bytes = Buffer.from(input), beginPayload: Payload = kind === "append" ? { action: "write-begin", kind, size } : { action: "write-begin", kind, name, size };
    let stageId: string | undefined, committed = false;
    try {
      const begin = resultRecord(await call(beginPayload), "id");
      if (typeof begin.id !== "string" || !UUID.test(begin.id)) fail();
      stageId = begin.id;
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, Math.min(offset + READ_CHUNK, bytes.length));
        const response = resultRecord(await call({ action: "write-chunk", id: begin.id, offset, bytes: chunk.toString("base64") }), "offset");
        if (response.offset !== offset + chunk.length) fail();
        offset += chunk.length;
      }
      const reply = resultRecord(await call({ action: "write-commit", id: begin.id }), "committed"); if (reply.committed !== true) fail(); committed = true;
    } finally {
      if (!committed && stageId) await call({ action: "write-cancel", id: stageId }).catch(() => {});
      clientStageBytes -= size; clientStageHandles--; bytes.fill(0);
    }
  };
  const reader: WorkerStateReader = {
    async readPolicy() { const item = await readCall(call, "read-policy"); try { return parseWorkerPolicy(item) as WorkerPolicy; } catch { return fail(); } },
    async readControl() { const item = await readCall(call, "read-control"); if (item !== "run" && item !== "drain" && item !== "stop") fail(); return item; },
    async readOffers(modelId) { const item = await readCall(call, "read-offers", modelId === undefined ? {} : { modelId }); if (!Array.isArray(item)) fail(); try { return item.map(parseWorkerOffer) as WorkerOffer[]; } catch { return fail(); } },
    async readAutoPrices(modelId) {
      const item = await readCall(call, "read-auto-prices", modelId === undefined ? {} : { modelId });
      if (!Array.isArray(item) || item.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")) fail();
      return new Map(item as [string, string][]);
    },
    async readJournalOwner() { return base64Bytes(await readCall(call, "read-journal-owner"), 1024); },
    async readJournal() { return await readAll("journal") ?? null; },
    async readResult(attemptId) { if (!UUID.test(attemptId)) fail(); return (await readAll("result", attemptId))!; },
    async readArtifact(attemptId, digest) { if (!UUID.test(attemptId) || !SHA256.test(digest)) fail(); return (await readAll("artifact", attemptId, digest))!; },
    async listOutputs(attemptId) {
      if (!UUID.test(attemptId)) fail(); const item = await readCall(call, "list-outputs", { attemptId });
      if (!Array.isArray(item) || item.some(name => !outputName(name) || !name.startsWith(attemptId + "."))) fail(); return Object.freeze([...item] as string[]);
    },
    async openSnapshot(request, signal) {
      if (!request || typeof request !== "object") fail();
      const kind = request.kind; if (kind !== "journal" && kind !== "result" && kind !== "artifact") fail();
      const expected = kind === "journal" ? "kind" : kind === "result" ? "attemptId,kind" : "attemptId,digest,kind";
      if (Object.keys(request).sort().join(",") !== expected) fail();
      const payload = snapshotPayload(kind, "attemptId" in request ? request.attemptId : undefined, "digest" in request ? request.digest : undefined);
      const value = await open(payload, kind, signal); if (!value) fail(); return value;
    },
    readSnapshot,
    closeSnapshot,
    async close() { if (closed) return; closed = true; const ids = [...clientSnapshots.keys()]; clientSnapshots.clear(); clientBytes = 0; await Promise.all(ids.map(async id => { try { await call({ action: "snapshot-close", id }); } catch {} })); },
  };
  const writer: WorkerStateWriter = {
    replace(relativeName, bytes) { return replaceViaChunks("replace", relativeName, bytes); },
    appendJournal(bytes) { return replaceViaChunks("append", "attempts.jsonl", bytes); },
    async removeOutput(relativeName) { if (!outputName(relativeName)) fail(); if (resultRecord(await call({ action: "remove-output", name: relativeName }), "removed").removed !== true) fail(); },
    async markShutdownUnverified() { if (resultRecord(await call({ action: "mark-shutdown-unverified" }), "marked").marked !== true) fail(); },
  };
  return Object.freeze({ reader, writer, async close() { await reader.close(); } });
}
