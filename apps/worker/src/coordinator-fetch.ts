import { Resolver } from "node:dns/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isPublicUnicast, parseCoordinatorOrigin, routeFor } from "./egress-policy.js";

type ResolverFunction = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
type InternalOptions = { origin: string; resolver: ResolverFunction; ca?: string | Buffer; loopbackFixture?: boolean };
const RESPONSE_HEADERS = new Set(["content-type", "content-length", "etag", "last-modified", "cache-control"]);
const REQUEST_FIELDS = new Set(["method", "headers", "body", "signal", "redirect", "cache"]);
const PRIVATE_BYTES = Buffer.from(["aa", "ron"].join(""), "ascii");
const unavailable = () => Error("COORDINATOR_TRANSPORT_UNAVAILABLE");

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
  const resolver = new Resolver();
  const abort = () => resolver.cancel(); signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    const addresses = answers.flatMap(answer => answer.status === "fulfilled" ? answer.value : []);
    if (!addresses.length || addresses.length > 64) throw unavailable();
    return addresses;
  } finally { signal.removeEventListener("abort", abort); }
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string" && !/[\r\n\u0000]/.test(value)) headers.set(name, value);
  }
  return headers;
}

function makeFetcher(options: InternalOptions): typeof fetch {
  const origin = parseCoordinatorOrigin(options.origin);
  let active = 0;
  return async (input, init = {}) => {
    if (input instanceof Request || Object.keys(init).some(key => !REQUEST_FIELDS.has(key))) throw unavailable();
    let url: URL;
    try { url = new URL(input); } catch { throw unavailable(); }
    if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash) throw unavailable();
    const method = init.method ?? "GET", route = routeFor(method, url.pathname);
    if (!route || active >= 8 || (init.redirect !== undefined && init.redirect !== "error")) throw unavailable();
    let headers: Headers;
    try { headers = new Headers(init.headers); } catch { throw unavailable(); }
    for (const [name] of headers) if (!["content-type", "accept"].includes(name)) throw unavailable();
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? Buffer.from(init.body, "utf8") : null;
    if (body === null || (method === "GET" && body !== undefined) || (body && body.byteLength > route.requestBytes) ||
        (method === "POST" && (!body || headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"))) throw unavailable();
    if (body) {
      const folded = Buffer.from(body);
      for (let i = 0; i < folded.byteLength; i++) if (folded[i]! >= 65 && folded[i]! <= 90) folded[i] = folded[i]! + 32;
      if (folded.includes(PRIVATE_BYTES)) throw unavailable();
    }
    const operation = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, operation.signal]) : operation.signal;
    const timer = setTimeout(() => operation.abort(), route.timeoutMs); timer.unref();
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; clearTimeout(timer); } };
    try {
      if (signal.aborted) throw unavailable();
      const addresses = await options.resolver(origin.hostname, signal);
      if (!addresses.length || addresses.length > 64 || addresses.some(address => !isPublicUnicast(address) &&
          !(options.loopbackFixture && ["127.0.0.1", "::1"].includes(address)))) throw unavailable();
      if (signal.aborted) throw unavailable();
      const address = addresses[0]!;
      return await new Promise<Response>((resolveResponse, rejectResponse) => {
        let responded = false;
        const fail = () => { release(); if (!responded) rejectResponse(unavailable()); };
        const request = https.request({ hostname: origin.hostname, port: origin.port, path: route.path, method,
          servername: origin.hostname, rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}),
          agent: false, signal,
          // Resolve exactly once, validate the complete answer set, then pin
          // this connection while TLS authenticates the original DNS hostname.
          lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
            ? callback(null, [{ address, family: isIP(address) }]) : callback(null, address, isIP(address)),
          headers: { ...(headers.get("accept") ? { accept: headers.get("accept")! } : {}),
            ...(body ? { "content-type": "application/json", "content-length": String(body.byteLength) } : {}) } },
        response => {
          const status = response.statusCode ?? 0, declared = response.headers["content-length"], encoding = response.headers["content-encoding"];
          if (status < 200 || status > 599 || (status >= 300 && status < 400) ||
              (encoding !== undefined && encoding !== "identity") ||
              (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > route.responseBytes))) {
            response.destroy(); fail(); return;
          }
          response.once("close", release); response.once("error", fail);
          const iterator = response[Symbol.asyncIterator](); let received = 0;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) {
                  if (declared !== undefined && Number(declared) !== received) throw unavailable();
                  release(); controller.close(); return;
                }
                const chunk = Buffer.from(next.value); received += chunk.byteLength;
                if (received > route.responseBytes) throw unavailable();
                controller.enqueue(chunk);
              } catch { response.destroy(); release(); controller.error(unavailable()); }
            },
            async cancel() { response.destroy(); release(); await iterator.return?.().catch(() => undefined); },
          });
          responded = true;
          resolveResponse(new Response([204, 205, 304].includes(status) ? null : stream, { status, headers: responseHeaders(response) }));
          if ([204, 205].includes(status)) { response.resume(); release(); }
        });
        request.once("error", fail); request.end(body);
      });
    } catch { release(); throw unavailable(); }
  };
}

/** Trusted host transport shared by signing and update callbacks. Child input
 * cannot select a destination, header, redirect, resolver or trust root. */
export function createCoordinatorFetcher(origin: string): typeof fetch {
  return makeFetcher({ origin, resolver: resolveAddresses });
}

/** Explicit local TLS fixture seam; production has no configurable DNS/CA bypass. */
export function __testOnlyCreateCoordinatorFetcher(options: {
  origin: string; ca: string | Buffer; resolver: ResolverFunction;
}): typeof fetch {
  return makeFetcher({ ...options, loopbackFixture: true });
}
