import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseCoordinatorOrigin } from "./egress-policy.js";

export interface CoordinatorEgressTransport {
  readonly origin: string;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

const CLIENT_HEADERS = ["content-type", "accept"] as const;

/** Client-side route binding for the worker's pathname-socket coordinator transport. */
export function createCoordinatorEgressTransport(socketPath: string, pairedOrigin: string): CoordinatorEgressTransport {
  if (!socketPath || socketPath.length > 100) throw new Error("Invalid coordinator broker socket path");
  const configured = parseCoordinatorOrigin(pairedOrigin);
  return Object.freeze({ origin: configured.origin, fetch: (input: string | URL | Request, init?: RequestInit) => fetchThroughSocket(socketPath, configured.origin, input, init) });
}

async function fetchThroughSocket(socketPath: string, pairedOrigin: string, input: string | URL | Request,
  init?: RequestInit): Promise<Response> {
  if (init?.redirect && init.redirect !== "error") throw new Error("Coordinator broker transport refuses redirects");
  const request = new Request(input, { ...init, redirect: "error" });
  const url = new URL(request.url);
  if (url.origin !== pairedOrigin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Coordinator request is outside the paired HTTPS origin");
  }
  if (request.method !== "GET" && request.method !== "POST") throw new Error("Coordinator request method is not allowed");

  const headers: Record<string, string> = { host: url.host };
  for (const name of CLIENT_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    let outgoing: ReturnType<typeof http.request>;
    try {
      outgoing = http.request({ socketPath, path: url.pathname, method: request.method, headers, agent: false,
        signal: request.signal }, incoming => {
        if ((incoming.statusCode ?? 0) >= 300 && (incoming.statusCode ?? 0) < 400) {
          incoming.destroy(); finishError(new Error("Coordinator broker refused a redirect")); return;
        }
        const responseHeaders = new Headers();
        for (const name of ["content-type", "content-length", "etag", "last-modified", "cache-control"] as const) {
          const value = incoming.headers[name];
          if (typeof value === "string") responseHeaders.set(name, value);
        }
        const status = incoming.statusCode ?? 502;
        const body = status === 204 || status === 304 || request.method === "HEAD" ? null :
          Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        settled = true;
        resolve(new Response(body, { status, ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}), headers: responseHeaders }));
      });
    } catch (error) { finishError(error instanceof Error ? error : new Error("Coordinator broker unavailable")); return; }
    outgoing.once("error", error => finishError(error));
    if (!request.body) { outgoing.end(); return; }
    try {
      void pipeline(Readable.fromWeb(request.body as import("node:stream/web").ReadableStream), outgoing,
        { signal: request.signal }).catch(error => finishError(error instanceof Error ? error : new Error("Invalid coordinator request body")));
    } catch (error) { outgoing.destroy(); finishError(error instanceof Error ? error : new Error("Invalid coordinator request body")); }
  });
}
