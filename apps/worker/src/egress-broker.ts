import { Resolver } from "node:dns/promises";
import { chmod, lstat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPublicUnicast, parseCoordinatorOrigin, routeFor, type CoordinatorOrigin, type EgressRoute } from "./egress-policy.js";

export type EgressPeerValidator = (socket: Socket, signal?: AbortSignal) => boolean | Promise<boolean>;
type ResolveAddresses = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
export interface EgressBrokerOptions {
  /** Linux filesystem AF_UNIX socket path. Its parent must already be private and non-symlinked. */
  socketPath: string;
  /** Immutable paired origin, supplied by service setup rather than controller-writable identity state. */
  origin: string;
  /** Must perform authenticated Linux peer and namespace checks. The broker has no permissive default. */
  validatePeer: EgressPeerValidator;
}

type InternalOptions = EgressBrokerOptions & {
  resolver: ResolveAddresses;
  ca?: string | Buffer;
  allowLoopbackForTest?: boolean;
  testTimeoutMs?: number;
  failChmodForTest?: boolean;
};

export interface EgressBroker {
  readonly origin: string;
  close(): Promise<void>;
}

const SAFE_REQUEST_HEADERS = new Set(["host", "content-type", "accept", "content-length", "transfer-encoding", "connection"]);
const SAFE_RESPONSE_HEADERS = new Set(["content-type", "content-length", "etag", "last-modified", "cache-control"]);
const canonicalLength = /^(?:0|[1-9][0-9]{0,11})$/;

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name) values.push(request.rawHeaders[index + 1]!);
  }
  return values;
}

function requestLength(request: IncomingMessage, route: EgressRoute): number | null {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (!SAFE_REQUEST_HEADERS.has(request.rawHeaders[index]!.toLowerCase())) throw new Error("header");
  }
  const lengths = rawHeaderValues(request, "content-length"), encodings = rawHeaderValues(request, "transfer-encoding");
  if (lengths.length > 1 || encodings.length > 1 || (lengths.length > 0 && encodings.length > 0)) throw new Error("framing");
  if (encodings.length && encodings[0]!.toLowerCase() !== "chunked") throw new Error("framing");
  if (lengths.length && !canonicalLength.test(lengths[0]!)) throw new Error("framing");
  const length = lengths.length ? Number(lengths[0]) : null;
  if (length !== null && length > route.requestBytes) throw new Error("large");
  const contentTypes = rawHeaderValues(request, "content-type");
  if (route.method === "POST") {
    if (contentTypes.length !== 1 || contentTypes[0]!.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw new Error("content");
  } else if ((length !== null && length > 0) || encodings.length) throw new Error("body");
  const hosts = rawHeaderValues(request, "host");
  if (hosts.length !== 1) throw new Error("host");
  return length;
}

function responseHeaders(response: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string" && !/[\r\n\u0000]/.test(value)) result[name] = value;
  }
  return result;
}

async function resolveAll(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) throw new Error("aborted");
    const addresses = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (addresses.length === 0) throw new Error("DNS resolution failed");
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { if (!settled) { settled = true; cleanup(); reject(new Error("aborted")); } };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(value => { if (!settled) { settled = true; cleanup(); resolve(value); } }, error => {
      if (!settled) { settled = true; cleanup(); reject(error); }
    });
  });
}

class RequestBodyLimitError extends Error {}
class InvalidRequestBodyError extends Error {}

async function boundedJsonBody(request: IncomingMessage, maximum: number, declaredLength: number | null,
  signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of request) {
      if (signal.aborted) throw new Error("aborted");
      const chunk = Buffer.from(value as Uint8Array);
      bytes += chunk.byteLength;
      if (bytes > maximum) throw new RequestBodyLimitError();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RequestBodyLimitError) throw error;
    throw signal.aborted ? new Error("aborted") : error;
  }
  if (declaredLength !== null && bytes !== declaredLength) throw new InvalidRequestBodyError();
  const body = Buffer.concat(chunks, bytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    JSON.parse(text);
  } catch { throw new InvalidRequestBodyError(); }
  return body;
}

function validAddressSet(addresses: readonly string[], allowLoopbackForTest: boolean): string[] {
  const testLoopback = (address: string) => address === "127.0.0.1" || address === "::1";
  if (!addresses.length || addresses.length > 16 || addresses.some(address => isIP(address) === 0 ||
      (!isPublicUnicast(address) && !(allowLoopbackForTest && testLoopback(address))))) {
    throw new Error("address");
  }
  return [...new Set(addresses)];
}

function replyError(response: ServerResponse, status = 403): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-length": "0", connection: "close" });
  response.end();
}

function bindAbort(request: IncomingMessage, response: ServerResponse, abort: AbortController): void {
  request.once("aborted", () => abort.abort());
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
}

async function forward(request: IncomingMessage, response: ServerResponse, options: InternalOptions,
  origin: CoordinatorOrigin, abort: AbortController): Promise<void> {
  let path = request.url;
  const route = path ? routeFor(request.method ?? "", path) : null;
  if (!route || request.httpVersionMajor !== 1 || request.httpVersionMinor > 1) return replyError(response);
  let declaredLength: number | null;
  try {
    const host = rawHeaderValues(request, "host");
    const expectedHost = origin.port === 443 ? origin.hostname : `${origin.hostname}:${origin.port}`;
    if (host.length !== 1 || host[0]!.toLowerCase() !== expectedHost.toLowerCase()) return replyError(response);
    declaredLength = requestLength(request, route);
    if (route.method === "POST" && declaredLength === 0) return replyError(response);
  } catch { return replyError(response); }

  bindAbort(request, response, abort);
  const timeoutMs = options.testTimeoutMs ?? route.timeoutMs;
  const timer = setTimeout(() => {
    abort.abort();
    if (route.method === "POST" && !request.complete) request.destroy();
  }, timeoutMs);
  const stopTimer = () => clearTimeout(timer);
  response.once("close", stopTimer);
  response.once("finish", stopTimer);
  timer.unref();
  try {
    let body: Buffer | undefined;
    if (route.method === "POST") {
      try { body = await boundedJsonBody(request, route.requestBytes, declaredLength, abort.signal); }
      catch (error) {
        stopTimer();
        if (error instanceof RequestBodyLimitError) {
          const clientSocket = request.socket;
          request.pause(); replyError(response, 413);
          response.once("finish", () => clientSocket?.destroy());
        } else replyError(response, abort.signal.aborted ? 504 : 400);
        return;
      }
    }
    const addresses = validAddressSet(await withAbort(options.resolver(origin.hostname, abort.signal), abort.signal), options.allowLoopbackForTest === true);
    if (abort.signal.aborted) return replyError(response, 504);
    const address = addresses[0]!;
    const upstream = https.request({
      protocol: "https:", hostname: address, port: origin.port, method: route.method, path: route.path,
      servername: origin.hostname,
      ...(options.ca ? { ca: options.ca } : {}),
      headers: {
        host: origin.port === 443 ? origin.hostname : `${origin.hostname}:${origin.port}`,
        connection: "close",
        ...(route.method === "POST" ? { "content-type": "application/json", "content-length": String(body?.byteLength ?? 0) } : {}),
        ...(request.headers.accept ? { accept: request.headers.accept } : {}),
      },
      rejectUnauthorized: true,
      agent: false,
      signal: abort.signal,
    }, upstreamResponse => {
      const tls = upstreamResponse.socket as import("node:tls").TLSSocket;
      // `servername` on the request is the paired DNS name; `https.request` performs
      // certificate-name validation against it before emitting this response.
      if (!tls.authorized) {
        upstreamResponse.destroy(); replyError(response, 502); return;
      }
      const status = upstreamResponse.statusCode ?? 0;
      if (status < 200 || status > 599) {
        upstreamResponse.destroy(); replyError(response, 502); return;
      }
      if (status >= 300 && status < 400) {
        upstreamResponse.destroy(); replyError(response, 502); return;
      }
      const declared = upstreamResponse.headers["content-length"];
      if (declared !== undefined && (!canonicalLength.test(declared) || Number(declared) > route.responseBytes)) {
        upstreamResponse.destroy(); replyError(response, 502); return;
      }
      response.writeHead(status, responseHeaders(upstreamResponse));
      let bytes = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(bytes > route.responseBytes ? new Error("response limit") : null, bytes > route.responseBytes ? undefined : chunk);
      } });
      void pipeline(upstreamResponse, limiter, response).catch(() => { abort.abort(); response.destroy(); });
    });
    upstream.once("error", () => replyError(response, abort.signal.aborted ? 504 : 502));
    if (route.method === "POST") {
      upstream.end(body);
    } else {
      request.resume();
      upstream.end();
    }
  } catch {
    stopTimer();
    replyError(response, abort.signal.aborted ? 504 : 502);
  }
}

async function createInternal(options: InternalOptions): Promise<EgressBroker> {
  if (!options.socketPath || options.socketPath.length > 100 || typeof options.validatePeer !== "function") throw new Error("Egress broker requires a socket path and authenticated peer validator");
  const origin = parseCoordinatorOrigin(options.origin);
  if (options.allowLoopbackForTest !== true && process.platform !== "linux") throw new Error("Coordinator broker requires Linux AF_UNIX and peer-credential support");
  if (options.allowLoopbackForTest !== true && (!options.socketPath.startsWith("/") || options.socketPath.includes("\\") || options.socketPath.includes("\0"))) {
    throw new Error("Production broker socket must be a Linux absolute filesystem path");
  }
  const directory = options.socketPath.slice(0, Math.max(options.socketPath.lastIndexOf("/"), options.socketPath.lastIndexOf("\\")));
  if (process.platform === "linux" && directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw new Error("Broker socket directory must be a same-user private non-symlink directory");
    }
  }
  const sockets = new Set<Socket>();
  const active = new Set<AbortController>();
  let activeRequests = 0;
  let activePeerValidations = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = http.createServer((request, response) => {
    if (closing || activeRequests >= 32) {
      request.resume();
      replyError(response, 503);
      response.once("finish", () => request.socket.destroy());
      return;
    }
    activeRequests++;
    const abort = new AbortController();
    active.add(abort);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests--;
      active.delete(abort);
      if (!response.writableEnded) abort.abort();
    };
    response.once("finish", release);
    response.once("close", release);
    if (activePeerValidations >= 16) {
      request.resume(); replyError(response, 503);
      response.once("finish", () => request.socket.destroy());
      return;
    }
    activePeerValidations++;
    let validatorFinished = false;
    const validation = Promise.resolve().then(() => options.validatePeer(request.socket, abort.signal))
      .then(Boolean, () => false).finally(() => {
        if (!validatorFinished) { validatorFinished = true; activePeerValidations--; }
      });
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<boolean>(resolve => {
      abortListener = () => resolve(false);
      abort.signal.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => { abort.abort(); resolve(false); }, 1000);
      timer.unref();
    });
    void (async () => {
      let trusted = false;
      try { trusted = await Promise.race([validation, timeout]); }
      finally {
        if (timer) clearTimeout(timer);
        if (abortListener) abort.signal.removeEventListener("abort", abortListener);
      }
      if (closing || abort.signal.aborted) { replyError(response, 503); return; }
      if (!trusted) { request.resume(); replyError(response, 403); return; }
      await forward(request, response, options, origin, abort);
    })().catch(() => replyError(response, 502));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.maxHeadersCount = 24;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10000;
  server.requestTimeout = 0; // Route-specific AbortSignal timeout also bounds archive streams.
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  if (process.platform === "linux" && (options.allowLoopbackForTest !== true || options.failChmodForTest === true)) {
    try {
      if (options.failChmodForTest) throw new Error("Injected socket permission failure");
      await chmod(options.socketPath, 0o600);
    }
    catch (error) {
      closing = true;
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      throw error;
    }
  }
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
  return Object.freeze({ origin: origin.origin, close });
}

/** Production entry: only cancellable DNS, checked HTTPS destinations and a mandatory native-authenticated peer gate. */
export function createEgressBroker(options: EgressBrokerOptions): Promise<EgressBroker> {
  if (process.platform !== "linux") return Promise.reject(new Error("Coordinator broker requires Linux AF_UNIX and peer-credential support"));
  return createInternal({ ...options, resolver: resolveAll });
}

/**
 * Test-only fixture seam for loopback TLS tests. It has no environment-variable activation path and is not
 * referenced by production entry points. Callers must explicitly provide a CA, resolver, loopback opt-in,
 * and peer validator; createEgressBroker never accepts these bypasses.
 */
export function __testOnlyCreateEgressBroker(options: EgressBrokerOptions & {
  allowLoopback: true; ca: string | Buffer; resolver: ResolveAddresses; testTimeoutMs?: number; failChmodForTest?: boolean;
}): Promise<EgressBroker> {
  if (options.testTimeoutMs !== undefined && (!Number.isSafeInteger(options.testTimeoutMs) || options.testTimeoutMs < 1 || options.testTimeoutMs > 1000)) {
    return Promise.reject(new Error("Invalid test-only broker timeout"));
  }
  return createInternal({ ...options, ca: options.ca, resolver: options.resolver, allowLoopbackForTest: true,
    ...(options.failChmodForTest === true ? { failChmodForTest: true } : {}) });
}
