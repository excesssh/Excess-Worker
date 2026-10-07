import { randomUUID } from "node:crypto";
import { AdapterError, parseTextRequest, parseTextResult, type AdapterProbe, type TextAdapter, type TextResult } from "@excess/adapters";
import { textChunkSchema, type TextChunk } from "@excess/protocol";
import type { WindowsControllerJson } from "./windows-controller.js";

type JsonRecord = Readonly<Record<string, WindowsControllerJson>>;
type Call = (payload: JsonRecord, signal?: AbortSignal) => Promise<WindowsControllerJson>;
type Event = { kind: "chunk"; chunk: TextChunk } | { kind: "probe"; proof: AdapterProbe } | { kind: "result"; result: TextResult } | { kind: "error"; code: string };
type Session = {
  id: string; abort: AbortController; event?: Event | undefined; wake?: (() => void) | undefined; acknowledge?: (() => void) | undefined;
  pulling: boolean; delivered: number; acknowledged: number; done: boolean; closing: boolean;
  task: Promise<void>; timer: ReturnType<typeof setTimeout>; pollTimer: ReturnType<typeof setTimeout>; reaping?: Promise<void>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const POLL_MS = 5000, POLL_IDLE_MS = 30_000;
function fail(code = "CONTROLLER_ADAPTER_INVALID"): never { throw new AdapterError(code); }
function record(value: unknown, fields?: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const item = value as JsonRecord;
  if (fields !== undefined && Object.keys(item).sort().join(",") !== fields) fail();
  return item;
}
function json(value: unknown): WindowsControllerJson {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 512 * 1024) fail("CONTROLLER_ADAPTER_RESPONSE_LIMIT");
  return JSON.parse(encoded) as WindowsControllerJson;
}
function safeError(error: unknown): string {
  return error instanceof AdapterError && SAFE_CODE.test(error.code) ? error.code : "CONTROLLER_ADAPTER_FAILED";
}
export interface WindowsAdapterHost {
  handle(payload: JsonRecord, signal: AbortSignal): Promise<WindowsControllerJson>;
  close(): Promise<void>;
}

/** The trusted host supplies one already configured adapter. The child cannot
 * select executables, model paths, backends, memory limits, or shell commands. */
export function createWindowsAdapterHost(adapter: TextAdapter, runSeconds: number): WindowsAdapterHost {
  if (!Number.isSafeInteger(runSeconds) || runSeconds < 1 || runSeconds > 3600) fail();
  let session: Session | undefined, closed = false, closing: Promise<void> | undefined;
  let residentMb = 0;
  const memory = () => {
    const value = adapter.residentMb?.() ?? residentMb;
    if (!Number.isSafeInteger(value) || value < 0 || value > 262144) fail("CONTROLLER_ADAPTER_MEMORY_INVALID");
    return value;
  };
  const reap = (current: Session): Promise<void> => {
    if (!current.reaping) {
      current.closing = true; current.abort.abort(); clearTimeout(current.timer); clearTimeout(current.pollTimer);
      current.acknowledge?.(); current.wake?.();
      current.reaping = (async () => {
        await adapter.stop();
        await current.task;
        if (session === current) session = undefined;
        residentMb = 0;
      })();
    }
    return current.reaping;
  };
  const start = (kind: "probe" | "execute", request?: unknown, streaming = false) => {
    if (closed || session) fail("CONTROLLER_ADAPTER_BUSY");
    const parsed = kind === "execute" ? parseTextRequest(request) : undefined;
    if (streaming && adapter.supportsStreaming !== true) fail("CONTROLLER_ADAPTER_STREAM_UNAVAILABLE");
    const abort = new AbortController();
    const current = { id: randomUUID(), abort, pulling: false, delivered: 0, acknowledged: 0, done: false, closing: false } as Session;
    const expire = () => { void reap(current).catch(() => { closed = true; }); };
    current.timer = setTimeout(expire, (runSeconds + 30) * 1000); current.timer.unref();
    current.pollTimer = setTimeout(expire, POLL_IDLE_MS); current.pollTimer.unref();
    session = current;
    current.task = Promise.resolve().then(async () => {
      try {
        if (abort.signal.aborted) fail("ADAPTER_ABORTED_OR_TIMED_OUT");
        if (kind === "probe") {
          const proof = await adapter.probe();
          residentMb = proof.peakRssMb;
          if (!current.closing) current.event = { kind: "probe", proof };
        } else {
          const result = await adapter.execute(parsed, { signal: abort.signal, ...(streaming ? { onChunk: async (value: TextChunk) => {
            if (abort.signal.aborted || current.event) fail("CONTROLLER_ADAPTER_STREAM_INVALID");
            const chunk = textChunkSchema.parse(value);
            if (chunk.sequence !== current.acknowledged + 1) fail("CONTROLLER_ADAPTER_STREAM_INVALID");
            current.event = { kind: "chunk", chunk };
            await new Promise<void>(resolve => { current.acknowledge = resolve; current.wake?.(); });
            current.acknowledge = undefined;
            if (abort.signal.aborted) fail("ADAPTER_ABORTED_OR_TIMED_OUT");
          } } : {}) });
          if (!current.closing) current.event = { kind: "result", result: parseTextResult(result) };
        }
      } catch (error) { if (!current.closing) current.event = { kind: "error", code: safeError(error) }; }
      finally { current.done = true; current.wake?.(); }
    });
    return { id: current.id };
  };
  const selected = (id: unknown): Session => {
    if (typeof id !== "string" || !UUID.test(id) || session?.id !== id || session.closing) fail("CONTROLLER_ADAPTER_SESSION_INVALID");
    return session;
  };
  const handle = async (payload: JsonRecord, signal: AbortSignal): Promise<WindowsControllerJson> => {
    if (closed || signal.aborted) fail("CONTROLLER_ADAPTER_CLOSED");
    const value = record(payload);
    if (value.action === "probe") { record(value, "action"); return start("probe"); }
    if (value.action === "execute") {
      record(value, "action,request,streaming"); if (typeof value.streaming !== "boolean") fail();
      return start("execute", value.request, value.streaming);
    }
    if (value.action === "stop") {
      record(value, "action"); if (session) await reap(session); else await adapter.stop(); residentMb = 0;
      return { stopped: true };
    }
    if (value.action === "pull") {
      record(value, "ack,action,id"); const current = selected(value.id);
      if (current.pulling || !Number.isSafeInteger(value.ack) || value.ack !== current.delivered) fail("CONTROLLER_ADAPTER_ACK_INVALID");
      current.pulling = true;
      clearTimeout(current.pollTimer);
      current.pollTimer = setTimeout(() => { void reap(current).catch(() => { closed = true; }); }, POLL_IDLE_MS); current.pollTimer.unref();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { current.abort.abort(); current.acknowledge?.(); current.wake?.(); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (value.ack !== current.acknowledged) {
          if (current.event?.kind !== "chunk" || current.event.chunk.sequence !== value.ack) fail("CONTROLLER_ADAPTER_ACK_INVALID");
          current.acknowledged = Number(value.ack); current.event = undefined; current.acknowledge?.();
        } else if (current.delivered && current.event?.kind === "chunk") fail("CONTROLLER_ADAPTER_ACK_INVALID");
        if (!current.event && !current.closing && !signal.aborted) await new Promise<void>(resolve => {
          current.wake = resolve; timer = setTimeout(resolve, POLL_MS);
        });
        if (signal.aborted || current.closing) { await reap(current); fail("ADAPTER_ABORTED_OR_TIMED_OUT"); }
        const event = current.event;
        if (!event) return { kind: "pending", residentMb: memory() };
        if (event.kind === "chunk") current.delivered = event.chunk.sequence;
        else {
          clearTimeout(current.timer); clearTimeout(current.pollTimer);
          if (session === current) session = undefined;
        }
        return json({ ...event, residentMb: memory() });
      } finally { if (timer) clearTimeout(timer); current.wake = undefined; current.pulling = false; signal.removeEventListener("abort", onAbort); }
    }
    fail();
  };
  return Object.freeze({ handle, close: () => {
    if (!closing) { closed = true; closing = (async () => { if (session) await reap(session); else await adapter.stop(); residentMb = 0; })(); }
    return closing;
  } });
}

/** Child-side facade: execution is pulled one event at a time. A chunk is
 * acknowledged only after the caller has accepted it, preserving backpressure. */
export function createWindowsTextAdapterClient(call: Call): TextAdapter {
  let residentMb = 0;
  const stop = async () => {
    const result = record(await call({ action: "stop" }), "stopped");
    if (result.stopped !== true) fail("CONTROLLER_ADAPTER_STOP_UNCONFIRMED"); residentMb = 0;
  };
  const perform = async (kind: "probe" | "execute", request?: unknown, options?: { signal?: AbortSignal; onChunk?: (chunk: TextChunk) => Promise<void> }): Promise<AdapterProbe | TextResult> => {
    const signal = options?.signal;
    if (signal?.aborted) fail("ADAPTER_ABORTED_OR_TIMED_OUT");
    const started = record(await call(kind === "probe" ? { action: "probe" } : { action: "execute", request: json(parseTextRequest(request)), streaming: !!options?.onChunk }, signal), "id");
    if (typeof started.id !== "string" || !UUID.test(started.id)) fail("CONTROLLER_ADAPTER_SESSION_INVALID");
    let ack = 0, finished = false;
    const onAbort = () => { void stop().catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) fail("ADAPTER_ABORTED_OR_TIMED_OUT");
        const event = record(await call({ action: "pull", id: started.id, ack }, signal));
        if (!Number.isSafeInteger(event.residentMb) || Number(event.residentMb) < 0 || Number(event.residentMb) > 262144) fail("CONTROLLER_ADAPTER_MEMORY_INVALID");
        residentMb = Number(event.residentMb);
        if (event.kind === "pending") { record(event, "kind,residentMb"); continue; }
        if (event.kind === "error") { record(event, "code,kind,residentMb"); if (typeof event.code !== "string" || !SAFE_CODE.test(event.code)) fail(); throw new AdapterError(event.code); }
        if (event.kind === "chunk") {
          record(event, "chunk,kind,residentMb"); const chunk = textChunkSchema.parse(event.chunk);
          if (kind !== "execute" || !options?.onChunk || chunk.sequence !== ack + 1) fail("CONTROLLER_ADAPTER_STREAM_INVALID");
          await options.onChunk(chunk); ack = chunk.sequence; continue;
        }
        if (event.kind === "probe" && kind === "probe") {
          record(event, "kind,proof,residentMb"); const proof = record(event.proof);
          if (proof.ok !== true || typeof proof.capabilityDigest !== "string" || !/^[0-9a-f]{64}$/.test(proof.capabilityDigest) ||
              !["cpu", "cuda", "vulkan"].includes(String(proof.backend)) || typeof proof.model !== "string" || typeof proof.runtime !== "string" ||
              typeof proof.probedAt !== "string" || !Number.isFinite(Date.parse(proof.probedAt)) ||
              ![proof.threads, proof.maxMemoryMb, proof.generatedTokens, proof.peakRssMb].every(value => Number.isSafeInteger(value) && Number(value) >= 0)) fail("CONTROLLER_ADAPTER_PROBE_INVALID");
          if(proof.backend==="cuda"&&(proof.gpuBoundary!=="windows-cuda-budget-v1"||proof.gpuOffloadedLayers!==37||
            ![proof.maxGpuMemoryMb,proof.peakGpuMemoryMb,proof.peakDedicatedGpuMemoryMb].every(value=>Number.isSafeInteger(value)&&Number(value)>0)||
            Number(proof.peakGpuMemoryMb)>Number(proof.maxGpuMemoryMb)||Number(proof.peakDedicatedGpuMemoryMb)>Number(proof.peakGpuMemoryMb)))fail("CONTROLLER_ADAPTER_PROBE_INVALID");
          finished = true; return proof as unknown as AdapterProbe;
        }
        if (event.kind === "result" && kind === "execute") { record(event, "kind,residentMb,result"); const result = parseTextResult(event.result); finished = true; return result; }
        fail("CONTROLLER_ADAPTER_RESPONSE_INVALID");
      }
    } finally { signal?.removeEventListener("abort", onAbort); if (!finished) await stop(); }
  };
  return Object.freeze({ supportsStreaming: true as const, residentMb: () => residentMb, stop,
    probe: () => perform("probe") as Promise<AdapterProbe>,
    execute: (request: unknown, options?: { signal?: AbortSignal; onChunk?: (chunk: TextChunk) => Promise<void> }) => perform("execute", request, options) as Promise<TextResult> });
}
