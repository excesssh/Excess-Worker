import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseCoordinatorOrigin } from "./egress-policy.js";

const NODE_VERSION = "v24.11.1";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_INFLIGHT_REQUESTS = 4;
const MAX_INFLIGHT_BYTES = 4 * MAX_FRAME_BYTES;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30000;
const START_TIMEOUT_MS = 10000;
const CLOSE_TIMEOUT_MS = 10000;
const OPERATIONS = new Set(["coordinator", "state", "adapter"]);
const SAFE_CODE = /^[A-Z0-9_-]{1,64}$/;
const TERMINATIONS = new Set(["none", "timeout", "stop", "parent-eof", "protocol-error", "output-backpressure", "output-unavailable"]);
const execute = promisify(execFile);
const require = createRequire(import.meta.url);

export type WindowsControllerOperation = "coordinator" | "state" | "adapter";
export type WindowsControllerJson = null | boolean | number | string | readonly WindowsControllerJson[] | { readonly [key: string]: WindowsControllerJson };
export interface WindowsControllerRequest {
  readonly id: number;
  readonly op: WindowsControllerOperation;
  readonly payload: Readonly<Record<string, WindowsControllerJson>>;
}
export type WindowsControllerHandler = (request: WindowsControllerRequest, signal: AbortSignal) => Promise<WindowsControllerJson>;
export interface WindowsControllerPins {
  /** Digest of the installed SHA256SUMS.txt, supplied by trusted installation metadata. */
  readonly packageInventorySha256: string;
  readonly nodeSha256: string;
  readonly entrySha256: string;
  readonly helperSha256: string;
}
export interface WindowsControllerOptions {
  readonly packageDir: string;
  readonly stateDir: string;
  readonly origin: string;
  readonly pins: WindowsControllerPins;
  readonly signal?: AbortSignal;
  readonly handleRequest: WindowsControllerHandler;
}
export interface WindowsControllerClosed {
  readonly type: "close";
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly termination: string;
  readonly errorCode?: string;
  readonly reaped: boolean;
  readonly cleaned: boolean;
  readonly peakInFlightRequests: number;
  readonly peakInFlightBytes: number;
}
export interface WindowsControllerRun {
  readonly events: AsyncIterable<WindowsControllerClosed>;
  readonly closed: Promise<WindowsControllerClosed>;
  stop(): Promise<WindowsControllerClosed>;
}

interface FixtureOptions extends Omit<WindowsControllerOptions, "pins"> {
  readonly helperPath: string;
  readonly helperSha256: string;
  readonly nodePath: string;
  readonly nodeSha256: string;
  readonly scratchRoot: string;
  readonly siblingPath: string;
  readonly scenario: "echo" | "malformed" | "oversized" | "duplicate-id" | "four-inflight" | "four-refill" | "nativefixture-loop-top" | "nativefixture-after-flush" | "five-inflight" | "long-session" | "module-probe" | "hang" | "flood";
  readonly pauseOutputMs?: number;
  /** Short operation timeout available only through the explicit fixture seam. */
  readonly operationTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  readonly responseIdDelta?: number;
  readonly duplicateResponse?: boolean;
  readonly onPhase?: (phase: string) => void;
}

interface CloseEvent extends WindowsControllerClosed {}
type HostFrame = Record<string, unknown>;
type FixtureMode = { readonly scenario: FixtureOptions["scenario"]; readonly nodePath: string; readonly nodeSha256: string; readonly siblingPath: string; readonly pauseOutputMs?: number; readonly operationTimeoutMs?: number; readonly sessionTimeoutMs?: number; readonly responseIdDelta?: number; readonly duplicateResponse?: boolean; readonly onPhase?: (phase: string) => void };

class CloseEvents implements AsyncIterable<WindowsControllerClosed> {
  private value: WindowsControllerClosed | undefined;
  private waiter: ((result: IteratorResult<WindowsControllerClosed>) => void) | undefined;
  private ended = false;
  push(value: WindowsControllerClosed): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) { this.waiter({ done: false, value }); this.waiter = undefined; }
    else this.value = value;
  }
  [Symbol.asyncIterator](): AsyncIterator<WindowsControllerClosed> {
    return { next: () => {
      if (this.value) { const value = this.value; this.value = undefined; return Promise.resolve({ done: false, value }); }
      if (this.ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolveNext => { this.waiter = resolveNext; });
    } };
  }
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function validHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function within(root: string, target: string): boolean {
  const base = resolve(root).replace(/[\\/]+$/, "") + sep;
  const full = resolve(target).replace(/[\\/]+$/, "") + sep;
  return full.toLowerCase().startsWith(base.toLowerCase());
}
async function noLinks(path: string): Promise<void> {
  const full = resolve(path), volume = parse(full).root;
  let current = volume;
  for (const part of relative(volume, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error("CONTROLLER_PATH_INVALID");
  }
}
async function hashFile(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes) throw Error("CONTROLLER_PACKAGE_INVALID");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
      if (count > info.size) throw Error("CONTROLLER_PACKAGE_CHANGED");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    if (count !== info.size) throw Error("CONTROLLER_PACKAGE_CHANGED");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function verifyPackage(packageDir: string, pins: WindowsControllerPins): Promise<{ node: string; entry: string }> {
  if (![pins.packageInventorySha256, pins.nodeSha256, pins.entrySha256].every(validHash)) throw Error("CONTROLLER_PINS_REQUIRED");
  const root = resolve(packageDir);
  await noLinks(root);
  const inventoryPath = join(root, "SHA256SUMS.txt");
  if (await hashFile(inventoryPath, 1024 * 1024) !== pins.packageInventorySha256) throw Error("CONTROLLER_PACKAGE_PIN_INVALID");
  const inventory = (await readFile(inventoryPath, "utf8")).split("\n");
  if (inventory.length < 2 || inventory[inventory.length - 1] !== "") throw Error("CONTROLLER_PACKAGE_INVALID");
  const expected = new Map<string, string>();
  for (const row of inventory.slice(0, -1)) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_@+./-]+)$/.exec(row);
    if (!match || match[2]!.startsWith("/") || match[2]!.split("/").some(part => !part || part === "." || part === "..") ||
        match[2] === "SHA256SUMS.txt" || expected.size >= MAX_PACKAGE_FILES) throw Error("CONTROLLER_PACKAGE_INVALID");
    const key = match[2]!.toLowerCase();
    if (expected.has(key)) throw Error("CONTROLLER_PACKAGE_INVALID");
    expected.set(key, match[1]!);
  }
  const nodeName = "node/node.exe", entryName = "app/worker/dist/windows-controller-entry.js";
  if (expected.get(nodeName) !== pins.nodeSha256 || expected.get(entryName) !== pins.entrySha256) throw Error("CONTROLLER_PACKAGE_REQUIRED");
  const seen = new Set<string>(); let total = 0, files = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 32) throw Error("CONTROLLER_PACKAGE_INVALID");
    await noLinks(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw Error("CONTROLLER_PACKAGE_INVALID");
      if (item.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!item.isFile()) throw Error("CONTROLLER_PACKAGE_INVALID");
      const name = relative(root, path).split(sep).join("/");
      if (name === "SHA256SUMS.txt") continue;
      const key = name.toLowerCase(), expectedHash = expected.get(key);
      if (!expectedHash || seen.has(key) || ++files > MAX_PACKAGE_FILES) throw Error("CONTROLLER_PACKAGE_INVALID");
      const info = await lstat(path);
      total += info.size;
      if (info.size > 128 * 1024 * 1024 || total > MAX_PACKAGE_BYTES || await hashFile(path, 128 * 1024 * 1024) !== expectedHash) throw Error("CONTROLLER_PACKAGE_INTEGRITY_INVALID");
      seen.add(key);
    }
  }
  await walk(root, 0);
  if (seen.size !== expected.size) throw Error("CONTROLLER_PACKAGE_INTEGRITY_INVALID");
  return { node: join(root, "node", "node.exe"), entry: join(root, "app", "worker", "dist", "windows-controller-entry.js") };
}

async function packageNativeDirectory(): Promise<string> {
  const adapterEntry = require.resolve("@excess/adapters");
  return resolve(dirname(adapterEntry), "..", "native");
}
async function protectScratchParent(): Promise<string> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA || !process.env.SystemRoot) throw Error("CONTROLLER_ISOLATION_UNAVAILABLE");
  const root = join(resolve(process.env.LOCALAPPDATA), "EXCESS", "controller-scratch");
  await mkdir(root, { recursive: true }); await noLinks(root);
  const script = "$ErrorActionPreference='Stop';$p=$env:EXCESS_CONTROLLER_SCRATCH;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    "$old=[IO.Directory]::GetAccessControl($p);if($old.GetOwner([Security.Principal.SecurityIdentifier]) -ne $u){throw 'OWNER'};" +
    "$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($u);" +
    "foreach($s in @($u.Value,'S-1-5-18','S-1-5-32-544')){$i=New-Object Security.Principal.SecurityIdentifier($s);" +
    "$r=New-Object Security.AccessControl.FileSystemAccessRule($i,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};" +
    "[IO.Directory]::SetAccessControl($p,$a)";
  try {
    await execute(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000, maxBuffer: 4096,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, EXCESS_CONTROLLER_SCRATCH: root } });
    await noLinks(root); return await realpath(root);
  } catch { throw Error("CONTROLLER_ISOLATION_UNAVAILABLE"); }
}

function validatePayload(value: unknown, depth = 0, budget = { count: 0 }): value is Readonly<Record<string, WindowsControllerJson>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 32) return false;
  const visit = (item: unknown, level: number): boolean => {
    if (level > 32 || ++budget.count > 65536) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return Buffer.byteLength(item, "utf8") <= MAX_FRAME_BYTES;
    if (Array.isArray(item)) return item.length <= 65536 && item.every(child => visit(child, level + 1));
    if (typeof item === "object") {
      const entries = Object.entries(item as Record<string, unknown>);
      return entries.length <= 65536 && entries.every(([key, child]) => Buffer.byteLength(key, "utf8") <= 4096 && visit(child, level + 1));
    }
    return false;
  };
  return Object.entries(value).every(([key, child]) => Buffer.byteLength(key, "utf8") <= 4096 && visit(child, depth + 1));
}

function eventQueue(): { queue: CloseEvents; publish(value: WindowsControllerClosed): void } {
  const queue = new CloseEvents(); return { queue, publish: value => queue.push(value) };
}

async function startNative(options: WindowsControllerOptions, native: { helperPath: string; helperSha256: string; packageDir: string; nodeSha256: string; entrySha256: string; fixture?: FixtureMode; scratchRoot?: string }): Promise<WindowsControllerRun> {
  native.fixture?.onPhase?.("native-entry");
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== NODE_VERSION) throw Error("CONTROLLER_ISOLATION_UNAVAILABLE");
  if (typeof options.handleRequest !== "function") throw Error("CONTROLLER_HANDLER_REQUIRED");
  if (options.signal?.aborted) throw Error("CONTROLLER_CANCELLED");
  native.fixture?.onPhase?.("origin-parse");
  const origin = parseCoordinatorOrigin(options.origin).origin;
  for (const hash of [native.helperSha256, native.nodeSha256, native.entrySha256]) if (!validHash(hash)) throw Error("CONTROLLER_PINS_REQUIRED");
  native.fixture?.onPhase?.("state-path-check");
  await noLinks(options.stateDir);
  const stateDir = await realpath(options.stateDir), packageDir = await realpath(options.packageDir);
  if (within(packageDir, stateDir) || within(stateDir, packageDir)) throw Error("CONTROLLER_PATH_INVALID");
  native.fixture?.onPhase?.("helper-hash");
  if (await hashFile(native.helperPath, 16 * 1024 * 1024) !== native.helperSha256) throw Error("CONTROLLER_HELPER_PIN_INVALID");
  const scratchRoot = native.scratchRoot ? await realpath(native.scratchRoot) : await protectScratchParent();
  if (within(packageDir, scratchRoot) || within(stateDir, scratchRoot)) throw Error("CONTROLLER_PATH_INVALID");
  const stateFile = join(stateDir, "identity.json"); native.fixture?.onPhase?.("state-file-check"); await noLinks(stateFile);
  const stateInfo = await lstat(stateFile);
  if (!stateInfo.isFile() || stateInfo.size < 1 || stateInfo.size > 65536) throw Error("CONTROLLER_STATE_INVALID");
  if (!native.fixture) {
    const files = await verifyPackage(packageDir, options.pins);
    if (files.node !== join(packageDir, "node", "node.exe") || files.entry !== join(packageDir, "app", "worker", "dist", "windows-controller-entry.js")) throw Error("CONTROLLER_PACKAGE_INVALID");
  }
  native.fixture?.onPhase?.("helper-pin-check");
  const helperPinPath = join(dirname(native.helperPath), "integrity-controller-win32.json");
  const helperPin = JSON.parse(await readFile(helperPinPath, "utf8")) as Record<string, unknown>;
  if (helperPin.profile !== "windows-appcontainer-controller-v1" || helperPin.sha256 !== native.helperSha256) throw Error("CONTROLLER_HELPER_PIN_INVALID");
  const config = native.fixture ? {
    mode: "fixture", packageDir, stateDir, origin, scratchRoot, timeoutMilliseconds: native.fixture.sessionTimeoutMs ?? 30000,
    packageInventorySha256: "0".repeat(64), nodeSha256: "0".repeat(64), entrySha256: "0".repeat(64),
    stateFiles: ["identity.json"], fixtureNodePath: native.fixture.nodePath, fixtureNodeSha256: native.fixture.nodeSha256,
    testScenario: native.fixture.scenario, testSiblingPath: native.fixture.siblingPath,
    testOperationTimeoutMilliseconds: native.fixture.operationTimeoutMs ?? 30000,
    testResponseIdDelta: native.fixture.responseIdDelta ?? 0,
    testDuplicateResponse: native.fixture.duplicateResponse ?? false,
  } : {
    mode: "production", packageDir, origin, scratchRoot,
    packageInventorySha256: options.pins.packageInventorySha256, nodeSha256: native.nodeSha256,
    entrySha256: native.entrySha256,
  };
  const line = JSON.stringify(config) + "\n";
  if (Buffer.byteLength(line, "utf8") > 65536) throw Error("CONTROLLER_CONFIG_TOO_LARGE");
  const events = eventQueue();
  native.fixture?.onPhase?.("helper-spawn");
  const child = require("node:child_process").spawn(native.helperPath, native.fixture ? ["--fixture-test"] : [], {
    cwd: scratchRoot, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
      TEMP: scratchRoot, TMP: scratchRoot }, stdio: ["pipe", "pipe", "pipe"],
  }) as import("node:child_process").ChildProcessWithoutNullStreams;
  let received: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let readyPid: number | null = null, status: HostFrame | undefined, cleanup = false, errorCode: string | undefined;
  let closedResolve: (value: WindowsControllerClosed) => void;
  let lastRequestId = 0, inFlightBytes = 0, pendingWriteBytes = 0, stopRequested = false;
  const activeOperations = new Map<number, { controller: AbortController; requestBytes: number }>();
  let outputAttachTimer: ReturnType<typeof setTimeout> | undefined;
  let outputAttached = false;
  let controlEnded = false;
  const closed = new Promise<WindowsControllerClosed>(resolveClose => { closedResolve = resolveClose; });
  let startResolve: (() => void) | undefined, startReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolveReady, rejectReady) => { startResolve = resolveReady; startReject = rejectReady; });
  const sendControl = (frame: object) => {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
    if (bytes.length > MAX_FRAME_BYTES) { native.fixture?.onPhase?.("control-frame-denied"); return false; }
    if (pendingWriteBytes + inFlightBytes + bytes.length > MAX_INFLIGHT_BYTES) { native.fixture?.onPhase?.("control-budget-denied"); return false; }
    if (child.stdin.destroyed || child.stdin.writableEnded) { native.fixture?.onPhase?.("control-closed"); return false; }
    pendingWriteBytes += bytes.length;
    try {
      child.stdin.write(bytes, error => {
        pendingWriteBytes -= bytes.length;
        if (error && !stopRequested) fail("CONTROLLER_CONTROL_PIPE_FAILED");
      });
      return true;
    } catch { pendingWriteBytes -= bytes.length; native.fixture?.onPhase?.("control-write-failed"); return false; }
  };
  const stopNative = () => {
    if (!stopRequested) {
      stopRequested = true;
      for (const operation of activeOperations.values()) operation.controller.abort();
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!controlEnded && !child.stdin.writableEnded && !child.stdin.destroyed) {
      controlEnded = true;
      try { child.stdin.end(Buffer.from('{"type":"stop"}\n', "utf8")); } catch { /* process close remains the cleanup authority */ }
    }
  };
  const fail = (code: string) => { errorCode = SAFE_CODE.test(code) ? code : "CONTROLLER_FAILED"; startReject?.(Error(errorCode)); stopNative(); };
  const handle = async (frame: HostFrame) => {
    if (frame.type === "pulse" && native.fixture) return;
    if (frame.type === "phase" && native.fixture) {
      if (Object.keys(frame).sort().join(",") !== "phase,type" || typeof frame.phase !== "string" || !/^[a-z-]{1,32}$/.test(frame.phase)) { fail("CONTROLLER_PHASE_INVALID"); return; }
      native.fixture.onPhase?.(frame.phase); return;
    }
    if (frame.type === "ready") {
      if (!Number.isInteger(frame.pid) || Number(frame.pid) <= 0 || readyPid !== null) { fail("CONTROLLER_START_INVALID"); return; }
      readyPid = Number(frame.pid);
      if (native.fixture?.pauseOutputMs) {
        child.stdout.pause();
        outputAttachTimer = setTimeout(() => child.stdout.resume(), native.fixture.pauseOutputMs);
      }
      startResolve?.(); return;
    }
    if (frame.type === "request") {
      const id = Number(frame.id), requestBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
      if (!Number.isSafeInteger(id) || id <= lastRequestId || typeof frame.op !== "string" || !OPERATIONS.has(frame.op) || !validatePayload(frame.payload)) { fail("CONTROLLER_REQUEST_INVALID"); return; }
      if (activeOperations.size >= MAX_INFLIGHT_REQUESTS || requestBytes > MAX_FRAME_BYTES || inFlightBytes + pendingWriteBytes + requestBytes > MAX_INFLIGHT_BYTES) { fail("CONTROLLER_INFLIGHT_LIMIT"); return; }
      lastRequestId = id; inFlightBytes += requestBytes;
      const request = Object.freeze({ id, op: frame.op as WindowsControllerOperation, payload: frame.payload as Readonly<Record<string, WindowsControllerJson>> });
      const controller = new AbortController();
      activeOperations.set(id, { controller, requestBytes });
      native.fixture?.onPhase?.("request-accepted-" + id);
      const onAbort = () => controller.abort(); options.signal?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          options.handleRequest(request, controller.signal),
          closed.then(() => { throw Error("CONTROLLER_CLOSED"); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("OPERATION_TIMEOUT")), native.fixture?.operationTimeoutMs ?? OPERATION_TIMEOUT_MS); }),
        ]);
        if (stopRequested) return;
        if (!validateJsonValue(response)) throw Error("HANDLER_RESPONSE_INVALID");
        native.fixture?.onPhase?.("handler-resolved-" + id);
        const responseId = native.fixture?.responseIdDelta === undefined ? request.id : request.id + native.fixture.responseIdDelta;
        const reply = { type: "response", id: responseId, ok: true, payload: response };
        if (!sendControl(reply)) throw Error("CONTROLLER_INFLIGHT_LIMIT");
        native.fixture?.onPhase?.("response-queued-" + id);
        if (native.fixture?.duplicateResponse) sendControl(reply);
      } catch (cause) {
        controller.abort();
        if (cause instanceof Error && cause.message === "OPERATION_TIMEOUT") { fail("OPERATION_TIMEOUT"); }
        else if (!stopRequested) sendControl({ type: "response", id: request.id, ok: false, code: "HANDLER_FAILED" });
      } finally {
        if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); activeOperations.delete(id); inFlightBytes -= requestBytes;
      }
      return;
    }
    if (frame.type === "status") {
      if (Object.keys(frame).sort().join(",") !== "errorCode,exitCode,peakInFlightBytes,peakInFlightRequests,pid,reaped,termination,type" || !Number.isInteger(frame.pid) ||
          typeof frame.reaped !== "boolean" || typeof frame.termination !== "string" || !TERMINATIONS.has(frame.termination) ||
          typeof frame.errorCode !== "string" || !SAFE_CODE.test(frame.errorCode) ||
          !Number.isInteger(frame.exitCode) || !Number.isInteger(frame.peakInFlightRequests) || Number(frame.peakInFlightRequests) < 0 || Number(frame.peakInFlightRequests) > MAX_INFLIGHT_REQUESTS ||
          !Number.isInteger(frame.peakInFlightBytes) || Number(frame.peakInFlightBytes) < 0 || Number(frame.peakInFlightBytes) > MAX_INFLIGHT_BYTES ||
          (readyPid !== null && frame.pid !== readyPid)) { fail("CONTROLLER_STATUS_INVALID"); return; }
      status = frame; return;
    }
    if (frame.type === "cleanup") {
      if (Object.keys(frame).sort().join(",") !== "ok,type" || typeof frame.ok !== "boolean") { fail("CONTROLLER_CLEANUP_INVALID"); return; }
      cleanup = frame.ok; return;
    }
    if (frame.type === "error") {
      if (typeof frame.code !== "string" || !SAFE_CODE.test(frame.code)) { fail("CONTROLLER_ERROR_INVALID"); return; }
      errorCode = frame.code; startReject?.(Error(frame.code)); return;
    }
    fail("CONTROLLER_FRAME_INVALID");
  };
  const consume = (chunk: Buffer) => {
    if (chunk.length > MAX_FRAME_BYTES + 1) { fail("CONTROLLER_FRAME_TOO_LARGE"); return; }
    received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);
    for (;;) {
      const newline = received.indexOf(10); if (newline < 0) break;
      const lineBytes = received.subarray(0, newline); received = received.subarray(newline + 1);
      if (lineBytes.length === 0 || lineBytes.length > MAX_FRAME_BYTES) { fail("CONTROLLER_FRAME_INVALID"); return; }
      let frame: HostFrame;
      try { frame = JSON.parse(lineBytes.toString("utf8")) as HostFrame; }
      catch { fail("CONTROLLER_FRAME_INVALID"); return; }
      void handle(frame).catch(() => fail("CONTROLLER_FRAME_INVALID"));
    }
    if (received.length > MAX_FRAME_BYTES) fail("CONTROLLER_FRAME_TOO_LARGE");
  };
  const attachOutput = () => { if (!outputAttached) { outputAttached = true; child.stdout.on("data", consume); } };
  if (native.fixture?.pauseOutputMs !== undefined) {
    if (!Number.isInteger(native.fixture.pauseOutputMs) || native.fixture.pauseOutputMs < 0 || native.fixture.pauseOutputMs > 5000) throw Error("CONTROLLER_FIXTURE_DELAY_INVALID");
  }
  attachOutput();
  child.stderr.on("data", () => undefined);
  child.once("error", () => { errorCode = "CONTROLLER_START_FAILED"; startReject?.(Error(errorCode)); });
  child.once("close", (code, _signal) => {
    if (outputAttachTimer) clearTimeout(outputAttachTimer);
    stopRequested = true;
    for (const operation of activeOperations.values()) operation.controller.abort();
    options.signal?.removeEventListener("abort", abort);
    const result: CloseEvent = Object.freeze({ type: "close", pid: readyPid, exitCode: code, termination: typeof status?.termination === "string" ? status.termination : errorCode ?? "unconfirmed",
      ...(typeof status?.errorCode === "string" ? { errorCode: status.errorCode } : {}),
      reaped: status?.reaped === true, cleaned: cleanup && status?.reaped === true,
      peakInFlightRequests: Number(status?.peakInFlightRequests ?? 0), peakInFlightBytes: Number(status?.peakInFlightBytes ?? 0) });
    events.publish(result); closedResolve(result);
    if (!cleanup || status?.reaped !== true) startReject?.(Error("CONTROLLER_CLEANUP_UNCONFIRMED"));
    if (readyPid === null) startReject?.(Error(errorCode ?? "CONTROLLER_START_FAILED"));
  });
  const abort = () => { stopNative(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (native.fixture) native.fixture.onPhase?.(Buffer.byteLength(line, "utf8") > 16384 ? "config-large" : "config-small");
    const accepted = child.stdin.write(line);
    if (native.fixture) native.fixture.onPhase?.(accepted ? "config-write-accepted" : "config-write-blocked");
    if (!accepted) await new Promise<void>((resolveWrite, rejectWrite) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => { if (timer) clearTimeout(timer); child.stdin.removeListener("drain", onDrain); error ? rejectWrite(error) : resolveWrite(); };
      const onDrain = () => finish();
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", () => finish(Error("CONTROLLER_START_FAILED")));
      timer = setTimeout(() => finish(Error("CONTROLLER_START_TIMEOUT")), 5000);
    });
    if (native.fixture) native.fixture.onPhase?.("parent-config-written");
    await new Promise<void>((resolveEnd, rejectEnd) => {
      const timer = setTimeout(() => rejectEnd(Error("CONTROLLER_START_TIMEOUT")), START_TIMEOUT_MS);
      ready.then(() => { clearTimeout(timer); resolveEnd(); }, error => { clearTimeout(timer); rejectEnd(error); });
    });
    if (options.signal?.aborted) { stopNative(); throw Error("CONTROLLER_CANCELLED"); }
    return Object.freeze({ events: events.queue, closed, stop: async () => {
      stopNative();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([closed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("CONTROLLER_STOP_UNCONFIRMED")), CLOSE_TIMEOUT_MS); })]); }
      finally { if (timeout) clearTimeout(timeout); }
    } });
  } catch (cause) {
    if (outputAttachTimer) { clearTimeout(outputAttachTimer); outputAttachTimer = undefined; }
    attachOutput(); child.stdout.resume(); stopNative(); options.signal?.removeEventListener("abort", abort);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: WindowsControllerClosed;
      try {
        result = await Promise.race([
          closed,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("CONTROLLER_STOP_UNCONFIRMED")), CLOSE_TIMEOUT_MS); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (!result.reaped || !result.cleaned) throw Error("CONTROLLER_CLEANUP_UNCONFIRMED");
    } catch { throw Error("CONTROLLER_CLEANUP_UNCONFIRMED"); }
    throw cause instanceof Error && SAFE_CODE.test(cause.message) ? cause : Error("CONTROLLER_START_FAILED");
  }
}

function validateJsonValue(value: unknown, depth = 0): value is WindowsControllerJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_FRAME_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 65536 && value.every(item => validateJsonValue(item, depth + 1));
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).length <= 65536 && Object.entries(value as Record<string, unknown>).every(([key, item]) => Buffer.byteLength(key, "utf8") <= 4096 && validateJsonValue(item, depth + 1));
  return false;
}

/** Fail-closed production launch. The Windows-specific worker entry is an
 * explicit package prerequisite and is not synthesized from an unconfined entry. */
export async function startWindowsController(options: WindowsControllerOptions): Promise<WindowsControllerRun> {
  if (!options || typeof options.handleRequest !== "function" || !options.pins) throw Error("CONTROLLER_HANDLER_AND_PINS_REQUIRED");
  const nativeDir = await packageNativeDirectory();
  const helperPath = join(nativeDir, "ExcessController.exe");
  return startNative(options, { helperPath, helperSha256: options.pins.helperSha256, packageDir: options.packageDir,
    nodeSha256: options.pins.nodeSha256, entrySha256: options.pins.entrySha256 });
}

/** Explicit test-only fixture seam; never selected from an environment flag. */
export async function startWindowsControllerTestFixture(options: FixtureOptions): Promise<WindowsControllerRun> {
  const neutralRoot = "C:/ExcessBuilds/windows-controller-multiplex-proof";
  options?.onPhase?.("fixture-entry");
  if (!options || !within(neutralRoot, options.helperPath) || !within(neutralRoot, options.nodePath) || !within(neutralRoot, options.siblingPath)) throw Error("CONTROLLER_FIXTURE_PATH_INVALID");
  options.onPhase?.("fixture-paths-valid");
  if (options.operationTimeoutMs !== undefined && (!Number.isInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 100 || options.operationTimeoutMs > 5000)) throw Error("CONTROLLER_FIXTURE_TIMEOUT_INVALID");
  if (options.sessionTimeoutMs !== undefined && (!Number.isInteger(options.sessionTimeoutMs) || options.sessionTimeoutMs < 1000 || options.sessionTimeoutMs > 120000)) throw Error("CONTROLLER_FIXTURE_TIMEOUT_INVALID");
  if (options.responseIdDelta !== undefined && (!Number.isInteger(options.responseIdDelta) || options.responseIdDelta < 1 || options.responseIdDelta > 16)) throw Error("CONTROLLER_FIXTURE_RESPONSE_INVALID");
  if (options.duplicateResponse !== undefined && typeof options.duplicateResponse !== "boolean") throw Error("CONTROLLER_FIXTURE_RESPONSE_INVALID");
  const native: { helperPath: string; helperSha256: string; packageDir: string; nodeSha256: string; entrySha256: string; fixture: FixtureMode; scratchRoot?: string } = {
    helperPath: resolve(options.helperPath), helperSha256: options.helperSha256, packageDir: resolve(options.packageDir),
    nodeSha256: options.nodeSha256, entrySha256: "0".repeat(64), fixture: { scenario: options.scenario,
      nodePath: resolve(options.nodePath), nodeSha256: options.nodeSha256, siblingPath: resolve(options.siblingPath),
      ...(options.pauseOutputMs === undefined ? {} : { pauseOutputMs: options.pauseOutputMs }),
      ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
      ...(options.sessionTimeoutMs === undefined ? {} : { sessionTimeoutMs: options.sessionTimeoutMs }),
      ...(options.responseIdDelta === undefined ? {} : { responseIdDelta: options.responseIdDelta }),
      ...(options.duplicateResponse === undefined ? {} : { duplicateResponse: options.duplicateResponse }),
      ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }) },
    scratchRoot: resolve(options.scratchRoot),
  };
  options.onPhase?.("fixture-ready");
  return startNative({ ...options, pins: { packageInventorySha256: "0".repeat(64), nodeSha256: options.nodeSha256,
    entrySha256: "0".repeat(64), helperSha256: options.helperSha256 } }, native);
}
