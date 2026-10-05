import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import { createEgressBroker, __testOnlyCreateEgressBroker } from "../apps/worker/dist/egress-broker.js";
import { createCoordinatorEgressTransport } from "../apps/worker/dist/egress-transport.js";
import { isPublicUnicast, parseCoordinatorOrigin, routeFor } from "../apps/worker/dist/egress-policy.js";

function der(tag, content) {
  const length = content.length;
  const encodedLength = length < 128 ? Buffer.from([length]) : (() => {
    const parts = []; let value = length;
    while (value) { parts.unshift(value & 255); value = Math.floor(value / 256); }
    return Buffer.from([0x80 | parts.length, ...parts]);
  })();
  return Buffer.concat([Buffer.from([tag]), encodedLength, content]);
}

function derOid(value) {
  const arcs = value.split(".").map(BigInt);
  const values = [40n * arcs[0] + arcs[1], ...arcs.slice(2)];
  const encoded = [];
  for (let n of values) {
    const bytes = [Number(n & 0x7fn)]; n >>= 7n;
    while (n) { bytes.unshift(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
    encoded.push(...bytes);
  }
  return der(0x06, Buffer.from(encoded));
}

function makeEphemeralTlsFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sequence = (...values) => der(0x30, Buffer.concat(values));
  const integer = bytes => {
    let value = Buffer.from(bytes); while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return der(0x02, value);
  };
  const utc = date => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, "") + "Z"));
  const name = sequence(der(0x31, sequence(derOid("2.5.4.3"), der(0x0c, Buffer.from("coordinator.test")))));
  const now = new Date(), end = new Date(now); end.setUTCFullYear(end.getUTCFullYear() + 8);
  const extension = (id, value, critical = false) => sequence(derOid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const extensions = der(0xa3, sequence(
    extension("2.5.29.19", sequence(der(0x01, Buffer.from([0xff]))), true),
    extension("2.5.29.17", sequence(der(0x82, Buffer.from("coordinator.test")))),
    extension("2.5.29.37", sequence(derOid("1.3.6.1.5.5.7.3.1"))),
  ));
  const algorithm = sequence(derOid("1.2.840.10045.4.3.2"));
  const tbs = sequence(der(0xa0, integer(Buffer.from([2]))), integer(randomBytes(16)), algorithm,
    name, sequence(utc(now), utc(end)), name, publicKey.export({ type: "spki", format: "der" }), extensions);
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  // TLS accepts the serialized key here; keep it only in memory and never write or print it.
  return { cert: certPem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

async function responseOverSocket(socketPath, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers, agent: false }, response => {
      const parts = [];
      response.on("data", part => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function setup(t, { validatePeer = () => true, wrongCa = false, resolvedAddresses = ["127.0.0.1"], resolver, testTimeoutMs } = {}) {
  const { key, cert } = makeEphemeralTlsFixture();
  const hits = [];
  const postBodies = [];
  let archiveFinished = false;
  let archiveClosed = false;
  const server = https.createServer({ key, cert }, (request, response) => {
    hits.push({ method: request.method, url: request.url });
    if (request.url === "/v1/public-config") {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"product":"EXCESS"}'); return;
    }
    if (request.url === "/v1/devices/pairing/start") {
      const pieces = []; request.on("data", part => pieces.push(part)); request.on("end", () => {
        postBodies.push(Buffer.concat(pieces).toString("utf8"));
        response.writeHead(201, { "content-type": "application/json" }); response.end('{"ok":true}');
      }); return;
    }
    if (request.url === "/v1/market") {
      const size = 2 * 1024 * 1024 + 1;
      response.writeHead(200, { "content-type": "application/json", "content-length": String(size) }); response.end("x".repeat(size)); return;
    }
    if (request.url === "/downloads/release.json") {
      response.writeHead(302, { location: "https://elsewhere.invalid/" }); response.end(); return;
    }
    if (request.url?.startsWith("/downloads/excess-worker-")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.once("close", () => { if (!archiveFinished) archiveClosed = true; });
      response.write(Buffer.alloc(32768, 0x61));
      setTimeout(() => { response.write(Buffer.alloc(32768, 0x62)); archiveFinished = true; response.end(Buffer.alloc(32768, 0x63)); }, 250);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" }); response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  const origin = `https://coordinator.test:${port}`;
  const dir = process.platform === "win32" ? null : await mkdtemp(join(tmpdir(), "excess-egress-test-"));
  if (dir) await chmod(dir, 0o700);
  const socketPath = dir ? join(dir, "broker.sock") : `\\\\.\\pipe\\excess-egress-${randomUUID()}`;
  const broker = await __testOnlyCreateEgressBroker({ socketPath, origin, validatePeer, allowLoopback: true,
    ca: wrongCa ? Buffer.from("invalid CA fixture") : cert, ...(testTimeoutMs ? { testTimeoutMs } : {}),
    resolver: resolver ?? (async (name) => { assert.equal(name, "coordinator.test"); return resolvedAddresses; }) });
  t.after(async () => {
    await broker.close(); await new Promise(resolve => server.close(resolve));
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  return { origin, socketPath, broker, hits, postBodies, archiveFinished: () => archiveFinished, archiveClosed: () => archiveClosed };
}

test("paired-origin policy is canonical, exact, and rejects non-public production DNS answers", () => {
  assert.equal(parseCoordinatorOrigin("https://worker.example").port, 443);
  for (const origin of ["http://worker.example", "https://worker.example/path", "https://u@worker.example", "https://127.0.0.1", "https://[::1]", "https://[2001:4860:4860::8888]"]) {
    assert.throws(() => parseCoordinatorOrigin(origin));
  }
  assert.equal(routeFor("GET", "/v1/public-config")?.responseBytes, 65536);
  assert.equal(routeFor("POST", "/v1/worker/command")?.requestBytes, 2 * 524288 + 4096);
  assert.equal(routeFor("GET", "/downloads/excess-worker-1.2.3-aabbccddeeff-linux-x64.tar.gz")?.archive, true);
  for (const path of ["/v1/unknown", "/v1/public-config?next=x", "/v1/%2e%2e", "https://other.invalid/v1/public-config", "/v1\\public-config"]) {
    assert.equal(routeFor("GET", path), null);
  }
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPublicUnicast(address), false, address);
  assert.equal(isPublicUnicast("8.8.8.8"), true);
  assert.equal(isPublicUnicast("192.0.1.1"), true, "an adjacent IPv4 range is not rejected as a whole /16");
  assert.equal(isPublicUnicast("192.0.2.1"), false);
  assert.equal(isPublicUnicast("3fff::1"), false);
  assert.equal(isPublicUnicast("2001:4860:4860::8888"), true);
});

test("production broker cannot start without the native peer-authentication adapter", async () => {
  await assert.rejects(() => createEgressBroker({ socketPath: "/run/excess/broker.sock", origin: "https://worker.example" }),
    /peer validator|Linux AF_UNIX/);
});

test("only approved routes pass; unknown path, method, Host, query and traversal never hit origin", async t => {
  const state = await setup(t);
  const transport = createCoordinatorEgressTransport(state.socketPath, state.origin);
  const good = await transport.fetch(state.origin + "/v1/public-config");
  assert.equal(good.status, 200); assert.deepEqual(await good.json(), { product: "EXCESS" });
  const pairing = await transport.fetch(state.origin + "/v1/devices/pairing/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: "fixture" }),
  });
  assert.equal(pairing.status, 201); assert.deepEqual(state.postBodies, ['{"publicKey":"fixture"}']);
  const before = state.hits.length;
  for (const [method, path, headers] of [
    ["GET", "/v1/not-allowed", { host: new URL(state.origin).host }],
    ["POST", "/v1/public-config", { host: new URL(state.origin).host, "content-type": "application/json" }],
    ["GET", "/v1/public-config?redirect=x", { host: new URL(state.origin).host }],
    ["GET", "/v1/%2e%2e/downloads/release.json", { host: new URL(state.origin).host }],
    ["GET", "/v1/public-config", { host: "other.invalid" }],
  ]) {
    const result = await responseOverSocket(state.socketPath, path, { method, headers });
    assert.equal(result.status, 403, `${method} ${path}`);
  }
  assert.equal(state.hits.length, before);
  await assert.rejects(() => transport.fetch("https://other.invalid/v1/public-config"));
});

test("peer authentication failure is denied before coordinator access", async t => {
  const state = await setup(t, { validatePeer: () => false });
  const denied = await responseOverSocket(state.socketPath, "/v1/public-config", { headers: { host: new URL(state.origin).host } });
  assert.equal(denied.status, 403); assert.equal(state.hits.length, 0);
});

test("slow peer checks have a hard concurrency cap and shutdown aborts without waiting for deadlines", async t => {
  let validators = 0;
  const state = await setup(t, { validatePeer: (_socket, _signal) => {
    validators++;
    return new Promise(() => {});
  } });
  const host = new URL(state.origin).host;
  const pending = Array.from({ length: 16 }, () => responseOverSocket(state.socketPath, "/v1/public-config", { headers: { host } }).catch(() => null));
  for (let attempt = 0; attempt < 100 && validators < 16; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(validators, 16);
  const saturated = await responseOverSocket(state.socketPath, "/v1/public-config", { headers: { host } });
  assert.equal(saturated.status, 503);
  assert.equal(validators, 16, "saturated request is refused before spawning another peer check");
  const started = Date.now();
  await state.broker.close();
  assert.ok(Date.now() - started < 500, "broker shutdown closes sockets instead of waiting for route or peer deadlines");
  await Promise.all(pending);
  assert.equal(state.hits.length, 0);
});

test("pipelined requests cannot start multiple peer verifiers on one socket", async t => {
  let validators = 0;
  const state = await setup(t, { validatePeer: async () => { validators++; return false; } });
  const socket = net.createConnection(state.socketPath);
  await once(socket, "connect");
  socket.write(`GET /v1/public-config HTTP/1.1\r\nHost: ${new URL(state.origin).host}\r\n\r\nGET /v1/public-config HTTP/1.1\r\nHost: ${new URL(state.origin).host}\r\nConnection: close\r\n\r\n`);
  let response = "";
  socket.on("data", chunk => response += chunk.toString("latin1"));
  await once(socket, "close");
  assert.match(response, /HTTP\/1\.1 403/);
  assert.equal(validators, 1);
  assert.equal(state.hits.length, 0);
});

test("failed socket permission setup closes the listener", async t => {
  if (process.platform !== "linux") return t.skip("filesystem socket chmod applies only on Linux");
  const { key, cert } = makeEphemeralTlsFixture();
  const server = https.createServer({ key, cert });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const dir = await mkdtemp(join(tmpdir(), "excess-egress-chmod-")); await chmod(dir, 0o700);
  const socketPath = join(dir, "broker.sock");
  try {
    await assert.rejects(__testOnlyCreateEgressBroker({ socketPath, origin: `https://coordinator.test:${server.address().port}`,
      validatePeer: () => true, allowLoopback: true, ca: cert, failChmodForTest: true,
      resolver: async () => ["127.0.0.1"] }), /permission failure/);
    await assert.rejects(responseOverSocket(socketPath, "/v1/public-config", { headers: { host: "coordinator.test" } }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a private or rebound DNS answer is rejected before the coordinator is contacted", async t => {
  const state = await setup(t, { resolvedAddresses: ["10.0.0.8"] });
  const denied = await responseOverSocket(state.socketPath, "/v1/public-config", { headers: { host: new URL(state.origin).host } });
  assert.equal(denied.status, 502); assert.equal(state.hits.length, 0);
});

test("DNS resolution is bounded by the route timeout and abort listeners are removed", async t => {
  let abortCount = 0;
  const resolver = (_name, signal) => new Promise((_resolve, reject) => {
    const onAbort = () => { abortCount++; signal.removeEventListener("abort", onAbort); reject(new Error("test resolver aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const state = await setup(t, { resolver, testTimeoutMs: 40 });
  const started = Date.now();
  const denied = await responseOverSocket(state.socketPath, "/v1/public-config", { headers: { host: new URL(state.origin).host } });
  assert.equal(denied.status, 504); assert.ok(Date.now() - started < 1000);
  assert.equal(abortCount, 1); assert.equal(state.hits.length, 0);
});

test("declared oversized request is denied before coordinator access", async t => {
  const state = await setup(t);
  const huge = await responseOverSocket(state.socketPath, "/v1/worker/heartbeat", { method: "POST",
    headers: { host: new URL(state.origin).host, "content-type": "application/json", "content-length": "32769" } });
  assert.equal(huge.status, 403); assert.equal(state.hits.length, 0);
});

test("invalid, oversized, and errored POST bodies never reach the upstream", async t => {
  const state = await setup(t);
  const host = new URL(state.origin).host;
  const invalid = await responseOverSocket(state.socketPath, "/v1/devices/pairing/start", { method: "POST",
    headers: { host, "content-type": "application/json" }, body: "not-json" });
  assert.equal(invalid.status, 400); assert.equal(state.hits.length, 0);

  const oversized = await responseOverSocket(state.socketPath, "/v1/worker/heartbeat", { method: "POST",
    headers: { host, "content-type": "application/json" }, body: " ".repeat(32769) });
  assert.equal(oversized.status, 413); assert.equal(state.hits.length, 0);

  const transport = createCoordinatorEgressTransport(state.socketPath, state.origin);
  const erroredBody = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"partial":'));
    setTimeout(() => controller.error(new Error("synthetic request stream failure")), 0);
  } });
  await assert.rejects(() => transport.fetch(state.origin + "/v1/devices/pairing/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: erroredBody, duplex: "half",
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.hits.length, 0);
});

test("TLS identity is validated, redirects are not followed, and response caps stop oversized bodies", async t => {
  const state = await setup(t);
  const redirect = await responseOverSocket(state.socketPath, "/downloads/release.json", { headers: { host: new URL(state.origin).host } });
  assert.equal(redirect.status, 502);
  assert.equal(state.hits.at(-1).url, "/downloads/release.json");
  const oversized = await responseOverSocket(state.socketPath, "/v1/market", { headers: { host: new URL(state.origin).host } });
  assert.equal(oversized.status, 502);
  assert.equal(state.hits.length, 2);
  assert.equal(await responseOverSocket(state.socketPath, "/downloads/release.json", { headers: { host: "wrong.test" } }).then(x => x.status), 403);

  const badTls = await setup(t, { wrongCa: true });
  const failed = await responseOverSocket(badTls.socketPath, "/v1/public-config", { headers: { host: new URL(badTls.origin).host } });
  assert.equal(failed.status, 502);
  assert.equal(badTls.hits.length, 0);
});

test("release archive is streamed through the socket without whole-body buffering", async t => {
  const state = await setup(t);
  const transport = createCoordinatorEgressTransport(state.socketPath, state.origin);
  const path = "/downloads/excess-worker-1.2.3-aabbccddeeff-linux-x64.tar.gz";
  const response = await transport.fetch(state.origin + path);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.ok(first.value.byteLength > 0);
    assert.equal(state.archiveFinished(), false, "first body bytes arrive before upstream completes");
    let total = first.value.byteLength;
    for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; }
    assert.equal(total, 3 * 32768);
  } finally { await reader.cancel().catch(() => {}); }
});

test("archive response cancellation stops the upstream stream", async t => {
  const state = await setup(t);
  const transport = createCoordinatorEgressTransport(state.socketPath, state.origin);
  const path = "/downloads/excess-worker-1.2.3-aabbccddeeff-linux-x64.tar.gz";
  const controller = new AbortController();
  const response = await transport.fetch(state.origin + path, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.byteLength > 0);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; attempt < 50 && !state.archiveClosed(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.archiveClosed(), true);
});
