import { randomUUID } from "node:crypto";
import { MAX_WORKER_MESSAGE_BYTES, RELEASE_MANIFEST_MAX_BYTES, parseWorkerMessage, priceMicros } from "@excess/protocol";
import { WorkerConnectionError, type WorkerConnection, type CoordinatorFetcher, type HeartbeatCapacity } from "./identity.js";
import { parseCoordinatorOrigin } from "./egress-policy.js";
import type { ResourceObservation } from "./policy.js";
import type { WorkerOffer } from "./offer.js";
import type { WindowsControllerJson } from "./windows-controller.js";
import type { UpdateCheck } from "./update.js";

type Payload = Readonly<Record<string, WindowsControllerJson>>;
type Call = (payload: Payload, signal?: AbortSignal) => Promise<WindowsControllerJson>;
const COMMANDS = new Set(["worker.poll", "job.input", "job.started", "job.renew", "job.chunk", "job.failed", "job.artifact", "job.artifact.read", "job.result", "job.usage"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_VERSION = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+(?:[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?";
const RELEASE_ID = new RegExp(`^${RELEASE_VERSION}-[0-9a-f]{12}$`);
const MAX_RESPONSE = 768 * 1024;
function fail(): never { throw Error("CONTROLLER_COORDINATOR_INVALID"); }
function record(value: unknown, fields?: string): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as Payload;
  if (fields !== undefined && Object.keys(item).sort().join(",") !== fields) fail();
  return item;
}
function json(value: unknown): WindowsControllerJson {
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_RESPONSE) fail();
  return JSON.parse(raw) as WindowsControllerJson;
}
function updateCheck(value: unknown, expectedCurrent?: string | null): UpdateCheck {
  const item = record(value, "available,checkedAt,current,latest");
  const validId = (id: unknown) => typeof id === "string" && RELEASE_ID.test(id) &&
    Buffer.byteLength(id.slice(0, -13), "utf8") <= RELEASE_MANIFEST_MAX_BYTES;
  if ((item.current !== null && !validId(item.current)) ||
      !validId(item.latest) || typeof item.available !== "boolean" ||
      typeof item.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.checkedAt) ||
      !Number.isFinite(Date.parse(item.checkedAt)) || new Date(item.checkedAt).toISOString() !== item.checkedAt ||
      (expectedCurrent !== undefined && item.current !== expectedCurrent) ||
      item.available !== (item.current !== null && item.latest !== item.current)) fail();
  return item as unknown as UpdateCheck;
}
function validateMessage(type: string, data: Payload, deviceId: string): void {
  // Validate before invoking even an injected connection. The host supplies all
  // envelope, identity, counter and signature fields; none come from the child.
  if (Object.hasOwn(data, "deviceId") || Object.hasOwn(data, "sequence")) fail();
  const raw = JSON.stringify({ version: 1, messageId: randomUUID(), correlationId: randomUUID(), sentAt: new Date().toISOString(), type,
    data: { ...data, deviceId, ...(type === "worker.heartbeat" ? { sequence: 0 } : {}) } });
  if (Buffer.byteLength(raw, "utf8") > MAX_WORKER_MESSAGE_BYTES) fail();
  try { parseWorkerMessage(raw); } catch { fail(); }
}

export interface WindowsCoordinatorHostOptions {
  readonly connection: WorkerConnection;
  readonly capabilityDigest: string;
  readonly fetcher: CoordinatorFetcher;
  readonly telemetry: () => Promise<ResourceObservation>;
  readonly readOffers: () => Promise<readonly WorkerOffer[]>;
  readonly update?: { readonly current: string | null; readonly check: (origin: string, current: string, signal: AbortSignal) => Promise<UpdateCheck> };
}
/** Fixed operations of the already paired host identity. This handler exposes
 * neither a URL transport nor a private key or device-selected signing API. */
export function createWindowsCoordinatorHost(options: WindowsCoordinatorHostOptions) {
  const { connection, capabilityDigest } = options;
  const update = options.update ? Object.freeze({ current: options.update.current, check: options.update.check }) : undefined;
  const origin = parseCoordinatorOrigin(connection.origin ?? "").origin;
  if (!UUID.test(connection.deviceId) || !/^[0-9a-f]{64}$/.test(capabilityDigest)) fail();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const operations = new Map<AbortController, Promise<void>>();
  return Object.freeze({
    async handle(payload: Payload, signal: AbortSignal): Promise<WindowsControllerJson> {
      if (closing || signal.aborted) fail();
      const operation = new AbortController(), abort = () => operation.abort();
      let finished!: () => void;
      operations.set(operation, new Promise<void>(resolve => { finished = resolve; })); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) operation.abort();
      try {
        const value = record(payload); let result: unknown;
        if (value.action === "metadata") { record(value, "action"); result = { deviceId: connection.deviceId, origin, capabilityDigest }; }
        else if (value.action === "telemetry") { record(value, "action"); result = await options.telemetry(); }
        else if (value.action === "market") {
          record(value, "action");
          const response = await options.fetcher(origin + "/v1/market", { redirect: "error", signal: operation.signal });
          if (!response.ok || !response.body) { await response.body?.cancel(); throw new WorkerConnectionError(response.status); }
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
          try {
            for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > MAX_RESPONSE) fail(); chunks.push(item.value); }
            result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } else if (value.action === "update.check") {
          record(value, "action");
          if (!update || update.current === null) fail();
          result = updateCheck(await update.check(origin, update.current, operation.signal), update.current);
        } else if (value.action === "heartbeat") {
          record(value, "action,capacity"); const capacity = record(value.capacity, "availableSlots,capabilityDigests,totalSlots");
          if (capacity.totalSlots !== 1 || ![0, 1].includes(Number(capacity.availableSlots)) || typeof capacity.availableSlots !== "number" ||
              !Array.isArray(capacity.capabilityDigests) || capacity.capabilityDigests.length > 1 ||
              (capacity.capabilityDigests.length && capacity.capabilityDigests[0] !== capabilityDigest) ||
              (capacity.availableSlots === 1 && !capacity.capabilityDigests.length)) fail();
          validateMessage("worker.heartbeat", capacity, connection.deviceId);
          result = await connection.heartbeat(capacity as unknown as HeartbeatCapacity, operation.signal);
        } else if (value.action === "command") {
          record(value, "action,data,type"); if (typeof value.type !== "string" || !COMMANDS.has(value.type)) fail();
          const data = record(value.data); validateMessage(value.type, data, connection.deviceId);
          result = await connection.command(value.type, data, operation.signal);
        } else if (value.action === "offer") {
          record(value, "action,data"); const data = record(value.data);
          if (!connection.offer || data.capabilityDigest !== capabilityDigest || data.slots !== 1) fail();
          validateMessage("worker.offer", data, connection.deviceId);
          const configured = (await options.readOffers()).find(offer => offer.assetId === data.assetId);
          if (!configured || typeof data.netUnits !== "string") fail();
          const proposed = priceMicros(data.netUnits);
          if (configured.auto === "follow_lowest" && configured.minNetUnits !== undefined && configured.maxNetUnits !== undefined) {
            if (proposed < priceMicros(configured.minNetUnits) || proposed > priceMicros(configured.maxNetUnits)) fail();
          } else if (proposed !== priceMicros(configured.netUnits)) fail();
          if (operation.signal.aborted || closing) fail();
          result = await connection.offer(data, operation.signal);
        } else fail();
        return { ok: true, value: json(result) };
      } catch (error) {
        if (error instanceof WorkerConnectionError) return { ok: false, status: error.status, code: /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : "COORDINATOR_UNAVAILABLE" };
        throw Error("CONTROLLER_COORDINATOR_INVALID");
      } finally { operations.delete(operation); finished(); signal.removeEventListener("abort", abort); }
    },
    close(): Promise<void> {
      if (!closePromise) {
        closing = true;
        for (const operation of operations.keys()) operation.abort();
        closePromise = Promise.all([...operations.values()]).then(() => {});
      }
      return closePromise;
    },
  });
}

export async function createWindowsCoordinatorClient(call: Call): Promise<{ connection: WorkerConnection; fetcher: CoordinatorFetcher; telemetry(): Promise<ResourceObservation>; checkForUpdate(signal: AbortSignal): Promise<UpdateCheck> }> {
  const invoke = async (payload: Payload, signal?: AbortSignal): Promise<WindowsControllerJson> => {
    const response = record(await call(payload, signal));
    if (response.ok === true) { record(response, "ok,value"); return response.value!; }
    record(response, "code,ok,status");
    if (response.ok !== false || (response.status !== null && (!Number.isSafeInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599)) ||
        typeof response.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(response.code)) fail();
    throw new WorkerConnectionError(response.status as number | null, response.code);
  };
  const metadata = record(await invoke({ action: "metadata" }), "capabilityDigest,deviceId,origin");
  if (typeof metadata.deviceId !== "string" || !UUID.test(metadata.deviceId) || typeof metadata.origin !== "string" ||
      typeof metadata.capabilityDigest !== "string" || !/^[0-9a-f]{64}$/.test(metadata.capabilityDigest)) fail();
  const origin = parseCoordinatorOrigin(metadata.origin).origin;
  const fetcher: CoordinatorFetcher = async (input, init) => {
    // Runtime automatic pricing needs exactly one public read. Other requests
    // must use the typed connection, so no generic child-controlled HTTP leaks.
    if (!(typeof input === "string" || input instanceof URL) || String(input) !== origin + "/v1/market" ||
        (init?.method !== undefined && init.method !== "GET") || Object.keys(init ?? {}).some(key => !["method", "signal", "redirect"].includes(key)) ||
        (init?.redirect !== undefined && init.redirect !== "error")) fail();
    const value = await invoke({ action: "market" }, init?.signal ?? undefined);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return Object.freeze({
    connection: Object.freeze({ deviceId: metadata.deviceId, origin,
      heartbeat: (capacity: HeartbeatCapacity, signal?: AbortSignal) => invoke({ action: "heartbeat", capacity: json({ ...capacity, totalSlots: capacity.totalSlots ?? 1 }) }, signal),
      command: (type: string, data: Record<string, unknown>, signal?: AbortSignal) => invoke({ action: "command", type, data: json(data) }, signal),
      offer: (data: Record<string, unknown>, signal?: AbortSignal) => invoke({ action: "offer", data: json(data) }, signal),
    }), fetcher,
    checkForUpdate: async (signal: AbortSignal) => updateCheck(await invoke({ action: "update.check" }, signal)),
    telemetry: async () => {
      const value = record(await invoke({ action: "telemetry" }));
      if (Object.keys(value).some(key => !["freeMemoryMb", "idleSeconds", "onBattery", "cpuTempC", "gpuTempC"].includes(key)) ||
          ![value.freeMemoryMb, value.idleSeconds].every(item => item === null || typeof item === "number" && Number.isFinite(item) && item >= 0) ||
          (value.onBattery !== undefined && value.onBattery !== null && typeof value.onBattery !== "boolean") ||
          [value.cpuTempC, value.gpuTempC].some(item => item !== undefined && item !== null && (typeof item !== "number" || !Number.isFinite(item)))) fail();
      return value as unknown as ResourceObservation;
    },
  });
}
