import type { WorkerStateWriter } from "./controller-state.js";
import type { UpdateCheck } from "./update.js";

const MAX_CLIENT_BODY = 32 * 1024 * 1024;
const NAME_HEADER = "x-excess-state-name";

/** Typed client for the private controller state broker; it exposes no generic path or HTTP API. */
export interface ControllerStateClient extends WorkerStateWriter {
  check(current: string | null): Promise<UpdateCheck>;
  install(): Promise<number>;
  nextHeartbeatSequence(): Promise<number>;
}
export function createControllerStateClient(socketPath: string): ControllerStateClient {
  if (typeof socketPath !== "string" || !socketPath || socketPath.length > 100) throw new Error("Invalid controller state socket");
  const send = (route: string, bytes?: Uint8Array, name?: string): Promise<void> => {
    const body = bytes === undefined ? undefined : Buffer.from(bytes);
    if (body && body.byteLength > MAX_CLIENT_BODY) return Promise.reject(new Error("Controller state request exceeds limit"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new Error("Controller state broker unavailable")); } };
      const headers: http.OutgoingHttpHeaders = { connection: "close" };
      if (body) { headers["content-length"] = String(body.byteLength); headers["content-type"] = "application/octet-stream"; }
      if (name !== undefined) headers[NAME_HEADER] = name;
      const request = http.request({ socketPath, path: route, method: "POST", headers, agent: false, timeout: 30000 }, response => {
        response.resume();
        response.once("end", () => {
          if (settled) return;
          settled = true;
          if (response.statusCode === 204) resolve(); else reject(new Error("Controller state write refused"));
        });
        response.once("error", fail);
      });
      request.once("error", fail);
      request.once("timeout", () => { request.destroy(); fail(); });
      request.end(body);
    });
  };
  const sendJson = <T>(route: string, accept: (value: unknown) => value is T): Promise<T> => new Promise((resolve, reject) => {
    let settled = false, size = 0;
    const chunks: Buffer[] = [];
    const fail = () => { if (!settled) { settled = true; reject(new Error("Controller update broker unavailable")); } };
    const request = http.request({ socketPath, path: route, method: "POST", headers: { host: "localhost", connection: "close", "content-length": "0" }, agent: false, timeout: 30000 }, response => {
      response.on("data", (value: Buffer | string) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += bytes.byteLength;
        if (size > 1024) { request.destroy(); fail(); return; }
        chunks.push(bytes);
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        if (response.statusCode !== 200) { reject(new Error("Controller update request refused")); return; }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
          if (!accept(value)) throw new Error();
          resolve(value);
        } catch { reject(new Error("Controller update response invalid")); }
      });
      response.once("error", fail);
    });
    request.once("error", fail);
    request.once("timeout", () => { request.destroy(); fail(); });
    request.end();
  });
  const validCheck = (value: unknown): value is UpdateCheck => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "available,checkedAt,current,latest" ||
      (item.current !== null && typeof item.current !== "string") || typeof item.latest !== "string" ||
      typeof item.available !== "boolean" || typeof item.checkedAt !== "string" ||
      item.available !== (item.current !== null && item.current !== item.latest)) return false;
    const checked = Date.parse(item.checkedAt);
    return Number.isFinite(checked) && new Date(checked).toISOString() === item.checkedAt;
  };
  const validInstall = (value: unknown): value is { code: number } => !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && (value as { code?: unknown }).code !== undefined && [0, 1].includes((value as { code: number }).code);
  return Object.freeze({
    replace: (relativeName: string, bytes: Uint8Array) => send("/v1/replace", bytes, relativeName),
    appendJournal: (bytes: Uint8Array) => send("/v1/append-journal", bytes),
    removeOutput: (relativeName: string) => send("/v1/remove-output", undefined, relativeName),
    markShutdownUnverified: () => send("/v1/mark-shutdown-unverified"),
    check: (current: string | null) => { void current; return sendJson("/v1/update-check", validCheck); },
    install: () => sendJson("/v1/update-install", validInstall).then(result => result.code),
    nextHeartbeatSequence: () => sendJson("/v1/heartbeat-sequence", (value): value is { sequence: number } => !!value &&
      typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
      Number.isSafeInteger((value as { sequence?: unknown }).sequence) && Number((value as { sequence: number }).sequence) > 0)
      .then(result => result.sequence),
  });
}

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";
import type { Socket } from "node:net";
import type { ControllerStateStore } from "./controller-state.js";

export type ControllerStatePeerValidator = (socket: Socket, signal: AbortSignal) => boolean | Promise<boolean>;
export interface ControllerStateBrokerOptions {
  readonly socketPath: string;
  readonly store: ControllerStateStore;
  /** Mandatory native peer and namespace check. There is no permissive default. */
  readonly validatePeer: ControllerStatePeerValidator;
  /** Host-owned signed-update check and intent hooks. The child cannot supply an origin or installer command. */
  readonly updates?: ControllerUpdateCallbacks;
  /** Host-owned locked allocator; the child supplies no identity, path, or counter value. */
  readonly heartbeatSequence?: (signal: AbortSignal) => Promise<number>;
}
export interface ControllerStateBroker { close(): Promise<void>; }
export interface ControllerUpdateCallbacks {
  check(signal: AbortSignal): Promise<import("./update.js").UpdateCheck>;
  /** Records intent only; installation must happen in the host after child exit and cleanup. */
  requestInstall(signal: AbortSignal): Promise<number>;
}
type InternalOptions = ControllerStateBrokerOptions & { testPipe?: boolean; timeoutMs?: number; inFlightByteLimit?: number };
const MAX_CONNECTIONS = 16, MAX_ACTIVE = 8, MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
const MAX_BODY = 32 * 1024 * 1024, MAX_HEADERS = 8, MAX_HEADER_BYTES = 8192, STREAM_CHUNK_RESERVE = 256 * 1024;
const allowedHeaders = new Set(["host", "connection", "content-length", "content-type", "x-excess-state-name"]);
const paths = new Set(["/v1/replace", "/v1/append-journal", "/v1/remove-output", "/v1/mark-shutdown-unverified", "/v1/update-check", "/v1/update-install", "/v1/heartbeat-sequence"]);
const releaseIdPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?-[0-9a-f]{12}$/;
const UPDATE_CHECK_MAX_AGE_MS = 15 * 60 * 1000;
function fail(): never { throw new Error("CONTROLLER_STATE_BROKER_INVALID"); }
function reply(res: ServerResponse, status: number): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-length": "0", connection: "close" }); res.end();
}
function replyJson(res: ServerResponse, value: unknown, maximum = 1024): void {
  if (res.destroyed || res.headersSent) { if (!res.destroyed) res.destroy(); return; }
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > maximum) { reply(res, 502); return; }
  res.writeHead(200, { "content-type": "application/json", "content-length": String(bytes.byteLength), connection: "close" }); res.end(bytes);
}
function validUpdateCheck(value: unknown): value is import("./update.js").UpdateCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "available,checkedAt,current,latest" ||
      (item.current !== null && (typeof item.current !== "string" || item.current.length > 128 || !releaseIdPattern.test(item.current))) ||
      typeof item.latest !== "string" || item.latest.length > 128 || !releaseIdPattern.test(item.latest) ||
      typeof item.available !== "boolean" || item.available !== (item.current !== null && item.current !== item.latest) ||
      typeof item.checkedAt !== "string" || item.checkedAt.length > 32) return false;
  const instant = Date.parse(item.checkedAt);
  return Number.isFinite(instant) && new Date(instant).toISOString() === item.checkedAt;
}
function headerValues(req: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) found.push(req.rawHeaders[i + 1]!);
  return found;
}
function parsedLength(req: IncomingMessage): number {
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (!allowedHeaders.has(req.rawHeaders[i]!.toLowerCase())) fail();
  if (req.rawHeaders.length / 2 > MAX_HEADERS) fail();
  const values = headerValues(req, "content-length"), transfers = headerValues(req, "transfer-encoding");
  if (values.length > 1 || transfers.length || (values.length && !/^(?:0|[1-9][0-9]{0,8})$/.test(values[0]!))) fail();
  const length = values.length ? Number(values[0]) : 0;
  if (length > MAX_BODY) fail();
  return length;
}
async function bodyBytes(req: IncomingMessage, expected: number, signal: AbortSignal): Promise<Buffer> {
  const body = Buffer.allocUnsafe(expected); let size = 0;
  for await (const value of req) {
    if (signal.aborted) fail();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    if (size + chunk.byteLength > expected || size + chunk.byteLength > MAX_BODY) fail();
    chunk.copy(body, size); size += chunk.byteLength;
  }
  if (signal.aborted || size !== expected) fail();
  return body;
}
async function ensurePrivateSocketDirectory(socketPath: string): Promise<void> {
  const parent = dirname(resolve(socketPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const absolute = resolve(parent), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = current.endsWith(sep) ? `${current}${part}` : `${current}${sep}${part}`;
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  }
  const info = await lstat(parent);
  if (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)) fail();
}
async function createInternal(options: InternalOptions): Promise<ControllerStateBroker> {
  const socketPath = options.socketPath;
  if (!socketPath || socketPath.length > 100 || typeof options.validatePeer !== "function" || !options.store) fail();
  if (process.platform !== "linux" && options.testPipe !== true) throw new Error("Controller state broker requires Linux AF_UNIX peer validation");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 50 || options.timeoutMs > 30000)) fail();
  const inFlightByteLimit = options.inFlightByteLimit ?? MAX_IN_FLIGHT_BYTES;
  if (!Number.isSafeInteger(inFlightByteLimit) || inFlightByteLimit < 1 || inFlightByteLimit > MAX_IN_FLIGHT_BYTES) fail();
  let socketExists = false;
  if (!socketPath.startsWith("\\\\.\\pipe\\")) {
    await ensurePrivateSocketDirectory(socketPath);
    try {
      const info = await lstat(socketPath);
      if (!info.isSocket() || info.isSymbolicLink() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) fail();
      await unlink(socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  const peers = new Map<Socket, { controller: AbortController; valid: Promise<boolean> }>();
  const sockets = new Set<Socket>(), requests = new Set<AbortController>();
  let active = 0, inFlightBytes = 0, closing = false;
  let updateAvailableAt = 0;
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (closing) { reply(res, 503); return; }
    if (active >= MAX_ACTIVE) { reply(res, 503); res.once("finish", () => req.socket.destroy()); return; }
    active++;
    const operation = new AbortController(); requests.add(operation);
    const end = () => { if (requests.delete(operation)) active--; };
    req.once("aborted", () => operation.abort());
    res.once("close", () => { if (!res.writableEnded) operation.abort(); });
    const timer = setTimeout(() => { operation.abort(); if (!res.headersSent) reply(res, 408); req.socket.destroy(); }, options.timeoutMs ?? 15000);
    timer.unref();
    void (async () => {
      try {
        const route = req.url;
        if (req.method !== "POST" || !route || !paths.has(route) || req.httpVersionMajor !== 1 || req.httpVersionMinor > 1) { reply(res, 404); return; }
        const peer = peers.get(req.socket);
        if (!peer || !await peer.valid || operation.signal.aborted) { reply(res, 403); return; }
        const host = headerValues(req, "host");
        if (host.length !== 1 || host[0]!.toLowerCase() !== "localhost") { reply(res, 400); return; }
        const nameHeaders = headerValues(req, "x-excess-state-name"), lengths = parsedLength(req);
        const dataRoute = route === "/v1/replace" || route === "/v1/append-journal";
        const updateCheckRoute = route === "/v1/update-check", updateInstallRoute = route === "/v1/update-install";
        const heartbeatSequenceRoute = route === "/v1/heartbeat-sequence";
        if (route === "/v1/replace" || route === "/v1/remove-output") { if (nameHeaders.length !== 1 || nameHeaders[0]!.length > 256) { reply(res, 400); return; } }
        else if (nameHeaders.length) { reply(res, 400); return; }
        if (dataRoute) {
          const type = headerValues(req, "content-type");
          // A freshly paired worker starts with an empty durable journal.
          // Empty payloads remain invalid for every other mutation route.
          const emptyJournal = route === "/v1/replace" && nameHeaders[0] === "attempts.jsonl" && lengths === 0;
          if ((!emptyJournal && lengths < 1) || type.length !== 1 || type[0]!.toLowerCase() !== "application/octet-stream") { reply(res, 400); return; }
        } else if (updateCheckRoute) {
          if (lengths !== 0 || headerValues(req, "content-type").length) { reply(res, 400); return; }
        } else if (lengths !== 0 || headerValues(req, "content-type").length) { reply(res, 400); return; }
        const reservation = lengths ? lengths + STREAM_CHUNK_RESERVE : 0;
        if (inFlightBytes + reservation > inFlightByteLimit) { reply(res, 503); res.once("finish", () => req.socket.destroy()); return; }
        inFlightBytes += reservation;
        try {
          if (updateCheckRoute) {
            if (!options.updates || operation.signal.aborted || closing) { reply(res, 404); return; }
            const checked = await options.updates.check(operation.signal);
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            if (!validUpdateCheck(checked) || Date.now() - Date.parse(checked.checkedAt) > UPDATE_CHECK_MAX_AGE_MS || Date.parse(checked.checkedAt) > Date.now() + 30_000) {
              updateAvailableAt = 0; reply(res, 502); return;
            }
            updateAvailableAt = checked.available ? Date.now() : 0;
            replyJson(res, checked);
          } else if (updateInstallRoute) {
            if (!options.updates || operation.signal.aborted || closing) { reply(res, 404); return; }
            if (!updateAvailableAt || Date.now() - updateAvailableAt > UPDATE_CHECK_MAX_AGE_MS) { reply(res, 409); return; }
            const code = await options.updates.requestInstall(operation.signal);
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            if (code !== 0 && code !== 1) { reply(res, 502); return; }
            replyJson(res, { code });
          } else if (heartbeatSequenceRoute) {
            if (!options.heartbeatSequence || operation.signal.aborted || closing) { reply(res, 404); return; }
            const sequence = await options.heartbeatSequence(operation.signal);
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            if (!Number.isSafeInteger(sequence) || sequence <= 0) { reply(res, 502); return; }
            replyJson(res, { sequence }, 64);
          } else if (dataRoute) {
            const bytes = await bodyBytes(req, lengths, operation.signal);
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            if (route === "/v1/replace") await options.store.replaceFromBroker(nameHeaders[0]!, bytes);
            else await options.store.appendJournalFromBroker(bytes);
          } else if (route === "/v1/remove-output") {
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            await options.store.removeOutput(nameHeaders[0]!);
          } else {
            if (operation.signal.aborted || closing) { reply(res, 408); return; }
            await options.store.markShutdownUnverified();
          }
          if (!operation.signal.aborted && !closing && !res.destroyed) { res.writeHead(204, { "content-length": "0", connection: "close" }); res.end(); }
        } finally { if (dataRoute) inFlightBytes -= reservation; }
      } catch {
        reply(res, operation.signal.aborted || closing ? 408 : 400);
      } finally { clearTimeout(timer); end(); }
    })();
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;
  server.maxHeadersCount = MAX_HEADERS;
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 1;
  server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => { sockets.delete(socket); const peer = peers.get(socket); if (peer) { peer.controller.abort(); peers.delete(socket); } });
    if (sockets.size > MAX_CONNECTIONS || closing) { socket.destroy(); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000); timer.unref();
    let removeAbort = () => {};
    const aborted = new Promise<false>(resolveAbort => {
      const onAbort = () => resolveAbort(false);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
    });
    const valid = Promise.race([Promise.resolve().then(() => options.validatePeer(socket, controller.signal)).then(Boolean, () => false), aborted])
      .finally(() => { clearTimeout(timer); removeAbort(); });
    peers.set(socket, { controller, valid });
    void valid.then(ok => { if (!ok || closing || controller.signal.aborted) socket.destroy(); });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => { server.off("listening", onListen); rejectListen(error); };
    const onListen = () => { server.off("error", onError); resolveListen(); };
    server.once("error", onError); server.once("listening", onListen); server.listen(socketPath);
  }).catch(async error => { server.close(); if (socketExists) await unlink(socketPath).catch(() => {}); throw error; });
  if (!socketPath.startsWith("\\\\.\\pipe\\")) {
    try { await chmod(socketPath, 0o600); const info = await lstat(socketPath); if (!info.isSocket() || (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) fail(); socketExists = true; }
    catch (error) { closing = true; for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); await unlink(socketPath).catch(() => {}); throw error; }
  }
  return Object.freeze({
    async close() {
      if (closing) return;
      closing = true;
      for (const request of requests) request.abort();
      for (const peer of peers.values()) peer.controller.abort();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
      await options.store.drain();
      if (socketExists) { await unlink(socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); socketExists = false; }
    },
  });
}

/** Linux production broker: private local socket, mandatory native peer validation, no network interface. */
export function createControllerStateBroker(options: ControllerStateBrokerOptions): Promise<ControllerStateBroker> {
  if (process.platform !== "linux") return Promise.reject(new Error("Controller state broker requires Linux AF_UNIX"));
  return createInternal(options);
}
/** Explicit test-only seam for named-pipe integration tests on Windows. */
export function __testOnlyCreateControllerStateBroker(options: ControllerStateBrokerOptions & { namedPipe: true; timeoutMs?: number; inFlightByteLimit?: number }): Promise<ControllerStateBroker> {
  if (options.namedPipe !== true) return Promise.reject(new Error("Named pipe test mode must be explicit"));
  return createInternal({ ...options, testPipe: true, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.inFlightByteLimit === undefined ? {} : { inFlightByteLimit: options.inFlightByteLimit }) });
}

export const createLinuxControllerStateBroker = createControllerStateBroker;
