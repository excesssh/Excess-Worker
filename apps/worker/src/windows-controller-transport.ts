import type { Readable, Writable } from "node:stream";
import type { WindowsControllerJson, WindowsControllerOperation } from "./windows-controller.js";

type Payload = Readonly<Record<string, WindowsControllerJson>>;
type Pending = { op: WindowsControllerOperation; payload: Payload; bytes: number; id?: number; settled: boolean;
  resolve(value: WindowsControllerJson): void; reject(error: Error): void; signal?: AbortSignal | undefined;
  abort?: (() => void) | undefined; timer: ReturnType<typeof setTimeout> };
const MAX_FRAME_BYTES = 1024 * 1024, MAX_BYTES = 4 * MAX_FRAME_BYTES, MAX_ACTIVE = 4, MAX_QUEUED = 16;
const OPERATIONS = new Set(["coordinator", "state", "adapter"]);
const SAFE_CODE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const DEADLINE_MS = 30_000;
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_FRAME_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 65536 && value.every(item => validJson(item, depth + 1));
  return typeof value === "object" && Object.keys(value).length <= 65536 && Object.entries(value as object).every(([key, item]) => Buffer.byteLength(key, "utf8") <= 4096 && validJson(item, depth + 1));
}
export interface WindowsControllerTransport {
  call(op: WindowsControllerOperation, payload: Payload, signal?: AbortSignal): Promise<WindowsControllerJson>;
  finish(): Promise<void>;
  close(): void;
}
/** Only inherited anonymous pipes are used. No sockets, ports, filesystem
 * endpoints, discovery token, or ambient networking are selected by the child. */
export function createWindowsControllerTransport(input: Readable, output: Writable): WindowsControllerTransport {
  let received: Buffer<ArrayBufferLike> = Buffer.alloc(0), bytes = 0, lastId = 0, closed = false;
  const active = new Map<number, Pending>(), queue: Pending[] = [];
  const settle = (pending: Pending, error?: Error, value?: WindowsControllerJson) => {
    if (pending.settled) return;
    pending.settled = true;
    error ? pending.reject(error) : pending.resolve(value!);
  };
  const release = (pending: Pending) => {
    bytes -= pending.bytes; clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
  };
  const fail = (code: string) => {
    if (closed) return;
    closed = true; received = Buffer.alloc(0);
    input.removeListener("data", consume); input.removeListener("end", onEnd);
    const error = Error(SAFE_CODE.test(code) ? code : "CONTROLLER_TRANSPORT_FAILED");
    for (const pending of [...active.values(), ...queue]) { release(pending); settle(pending, error); }
    active.clear(); queue.length = 0;
  };
  const pump = () => {
    while (!closed && active.size < MAX_ACTIVE && queue.length) {
      const pending = queue.shift()!;
      if (pending.signal?.aborted) { release(pending); settle(pending, Error("CONTROLLER_OPERATION_ABORTED")); continue; }
      if (lastId >= Number.MAX_SAFE_INTEGER) { queue.unshift(pending); fail("CONTROLLER_SEQUENCE_EXHAUSTED"); return; }
      const id = ++lastId; pending.id = id; active.set(id, pending);
      const frame = Buffer.from(JSON.stringify({ type: "request", id, op: pending.op, payload: pending.payload }) + "\n", "utf8");
      if (frame.byteLength > MAX_FRAME_BYTES) { fail("CONTROLLER_FRAME_TOO_LARGE"); return; }
      try { output.write(frame, error => { if (error) fail("CONTROLLER_OUTPUT_FAILED"); }); }
      catch { fail("CONTROLLER_OUTPUT_FAILED"); }
    }
  };
  const accept = (line: Buffer) => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as Record<string, unknown>; }
    catch { fail("CONTROLLER_FRAME_INVALID"); return; }
    if (!value || Array.isArray(value) || value.type !== "response" || !Number.isSafeInteger(value.id) || typeof value.ok !== "boolean" ||
        Object.keys(value).sort().join(",") !== (value.ok ? "id,ok,payload,type" : "code,id,ok,type")) { fail("CONTROLLER_FRAME_INVALID"); return; }
    const pending = active.get(Number(value.id));
    if (!pending) { fail("CONTROLLER_RESPONSE_ID_INVALID"); return; }
    if (value.ok ? !validJson(value.payload) : typeof value.code !== "string" || !SAFE_CODE.test(value.code)) { fail("CONTROLLER_FRAME_INVALID"); return; }
    active.delete(Number(value.id)); release(pending);
    settle(pending, value.ok ? undefined : Error(String(value.code)), value.payload as WindowsControllerJson);
    pump();
  };
  const consume = (chunk: Buffer | string) => {
    if (closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Pipe reads may coalesce all four valid responses. Only an incomplete
    // frame is limited to one MiB; bound the aggregate before concatenation.
    if (data.byteLength > MAX_BYTES + MAX_ACTIVE) { fail("CONTROLLER_FRAME_TOO_LARGE"); return; }
    received = received.length ? Buffer.concat([received, data]) : data;
    for (;;) {
      const newline = received.indexOf(10); if (newline < 0) break;
      const line = received.subarray(0, newline); received = received.subarray(newline + 1);
      if (!line.length || line.length > MAX_FRAME_BYTES) { fail("CONTROLLER_FRAME_INVALID"); return; }
      accept(line); if (closed) return;
    }
    if (received.length > MAX_FRAME_BYTES) fail("CONTROLLER_FRAME_TOO_LARGE");
  };
  const onEnd = () => fail("CONTROLLER_PARENT_EOF"), onError = () => fail("CONTROLLER_PIPE_FAILED");
  input.on("data", consume); input.once("end", onEnd); input.on("error", onError); output.on("error", onError);
  return Object.freeze({
    call(op: WindowsControllerOperation, payload: Payload, signal?: AbortSignal): Promise<WindowsControllerJson> {
      if (closed || signal?.aborted) return Promise.reject(Error("CONTROLLER_OPERATION_ABORTED"));
      if (!OPERATIONS.has(op) || !payload || typeof payload !== "object" || Array.isArray(payload) || !validJson(payload)) return Promise.reject(Error("CONTROLLER_REQUEST_INVALID"));
      let size: number, snapshot: Payload;
      try { snapshot = JSON.parse(JSON.stringify(payload)) as Payload; size = Buffer.byteLength(JSON.stringify({ type: "request", id: Number.MAX_SAFE_INTEGER, op, payload: snapshot }) + "\n", "utf8"); }
      catch { return Promise.reject(Error("CONTROLLER_REQUEST_INVALID")); }
      if (size > MAX_FRAME_BYTES || bytes + size > MAX_BYTES || queue.length >= MAX_QUEUED) return Promise.reject(Error("CONTROLLER_INFLIGHT_LIMIT"));
      return new Promise((resolve, reject) => {
        const pending: Pending = { op, payload: snapshot, bytes: size, resolve, reject, signal, settled: false, timer: setTimeout(() => fail("CONTROLLER_OPERATION_TIMEOUT"), DEADLINE_MS) };
        pending.timer.unref();
        pending.abort = () => {
          // A sent request retains its ID until its bounded host response arrives,
          // so cancellation cannot turn that valid response into a replay.
          if (pending.id === undefined) { const index = queue.indexOf(pending); if (index >= 0) { queue.splice(index, 1); release(pending); } }
          settle(pending, Error("CONTROLLER_OPERATION_ABORTED"));
        };
        bytes += size; queue.push(pending); signal?.addEventListener("abort", pending.abort, { once: true });
        if (signal?.aborted) pending.abort(); pump();
      });
    },
    async finish(): Promise<void> {
      if (closed || active.size || queue.length) throw Error("CONTROLLER_FINISH_INVALID");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("CONTROLLER_OUTPUT_TIMEOUT")), 5000);
        output.write('{"type":"done"}\n', error => { clearTimeout(timer); error ? reject(Error("CONTROLLER_OUTPUT_FAILED")) : resolve(); });
      });
      fail("CONTROLLER_FINISHED");
    },
    close: () => fail("CONTROLLER_TRANSPORT_CLOSED"),
  });
}
