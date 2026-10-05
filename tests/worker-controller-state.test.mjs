import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __controllerStateStoreLimits, __testOnlyCreateControllerStateStore, createControllerStateStore } from "../apps/worker/dist/controller-state.js";
import { createControllerStateBroker, __testOnlyCreateControllerStateBroker, createControllerStateClient } from "../apps/worker/dist/controller-state-client.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const modelName = "qwen3-4b";
const blockedByteFixtures = () => [
  Buffer.from([0x41, 0x61, 0x52, 0x6f, 0x4e]),
  Buffer.from([0x41, 0, 0x61, 0, 0x52, 0, 0x6f, 0, 0x4e, 0]),
  Buffer.from([0, 0x41, 0, 0x61, 0, 0x52, 0, 0x6f, 0, 0x4e]),
];
async function stateFixture(t) {
  const base = await mkdtemp(join(tmpdir(), "excess-state-broker-"));
  const stateDir = join(base, "state");
  await mkdir(stateDir, { mode: 0o700 });
  if (process.platform === "linux") await chmod(stateDir, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, stateDir };
}
function pipeName(base = tmpdir()) { return process.platform === "linux" ? join(base, `broker-${randomUUID()}`, "socket") : `\\\\.\\pipe\\excess-worker-state-${randomUUID()}`; }
function makeBroker(options) { return process.platform === "linux" ? createControllerStateBroker(options) : __testOnlyCreateControllerStateBroker({ ...options, namedPipe: true }); }
function request(pipe, path, { body, name, headers = {}, method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: pipe, method, path, headers: {
      ...(body === undefined ? {} : { "content-length": String(body.length), "content-type": "application/octet-stream" }),
      ...(name === undefined ? {} : { "x-excess-state-name": name }), ...headers,
    } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    request.once("error", reject); request.end(body);
  });
}
async function startBroker(t, stateDir, options = {}) {
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: options.mark ?? (async () => {}) });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store,
    validatePeer: options.validatePeer ?? (async () => true), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.updates === undefined ? {} : { updates: options.updates }),
    ...(options.heartbeatSequence === undefined ? {} : { heartbeatSequence: options.heartbeatSequence }) });
  t.after(async () => { await broker.close(); await store.close(); });
  return { store, broker, socketPath };
}

test("state writer restricts names, limits file sizes, and protects immutable state", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await __testOnlyCreateControllerStateStore({ stateDir, markShutdownUnverified: async () => {}, limits: { maxFiles: 2, maxBytes: 64 } });
  t.after(() => store.close());
  await assert.rejects(store.replace("../identity.json", Buffer.from("x")), /CONTROLLER_STATE_INVALID/);
  await assert.rejects(store.replace("control.json", Buffer.from("x")), /CONTROLLER_STATE_INVALID/);
  await assert.rejects(store.replace("runtime.lock", Buffer.from("x")), /CONTROLLER_STATE_INVALID/);
  await assert.rejects(store.replace(`${uuid}.artifact.${digest}.txt`, Buffer.from("x")), /CONTROLLER_STATE_INVALID/);
  await store.replace("status.json", Buffer.from("1234"));
  await store.appendJournal(Buffer.from("ab"));
  await assert.rejects(store.replace("journal-owner.json", Buffer.from("x")), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await assert.rejects(store.replace("status.json", Buffer.alloc(65)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  assert.equal((await readFile(join(stateDir, "status.json"))).toString(), "1234");
  await store.replace("status.json", Buffer.from("ok"));
  assert.equal((await readFile(join(stateDir, "status.json"))).toString(), "ok");
});

test("production per-file ceilings match status, owner, journal, result, and artifact shapes", async t => {
  assert.deepEqual({ statusBytes: __controllerStateStoreLimits.statusBytes, ownerBytes: __controllerStateStoreLimits.ownerBytes,
    journalBytes: __controllerStateStoreLimits.journalBytes, resultBytes: __controllerStateStoreLimits.resultBytes,
    artifactBytes: __controllerStateStoreLimits.artifactBytes }, {
    statusBytes: 16 * 1024, ownerBytes: 1024, journalBytes: 8 * 1024 * 1024,
    resultBytes: 1024 * 1024, artifactBytes: 32 * 1024 * 1024,
  });
  const { stateDir } = await stateFixture(t);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  t.after(() => store.close());
  await assert.rejects(store.replace("status.json", Buffer.alloc(16 * 1024 + 1)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await assert.rejects(store.replace("journal-owner.json", Buffer.alloc(1025)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await assert.rejects(store.appendJournal(Buffer.alloc(8 * 1024 * 1024 + 1)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await assert.rejects(store.replace(`${uuid}.result.json`, Buffer.alloc(1024 * 1024 + 1)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await assert.rejects(store.replace(`${uuid}.artifact.${digest}.bin`, Buffer.alloc(32 * 1024 * 1024 + 1)), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await store.replace("status.json", Buffer.alloc(16 * 1024));
  await store.replace(`${uuid}.artifact.${digest}.bin`, Buffer.alloc(32 * 1024 * 1024));
});

test("serialized reservations prevent concurrent file-count and byte quota oversubscription", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await __testOnlyCreateControllerStateStore({ stateDir, markShutdownUnverified: async () => {}, limits: { maxFiles: 1, maxBytes: 8 } });
  t.after(() => store.close());
  const results = await Promise.allSettled([store.replace("status.json", Buffer.from("1234")), store.replace("journal-owner.json", Buffer.from("5678"))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await readdir(stateDir)).length, 1);
  await assert.rejects(store.replace("status.json", Buffer.from("12345")), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
});

test("an existing zero-byte journal can grow when the managed-file count is already full", async t => {
  const { stateDir } = await stateFixture(t);
  await writeFile(join(stateDir, "status.json"), "ok", { mode: 0o600 });
  await writeFile(join(stateDir, "attempts.jsonl"), "", { mode: 0o600 });
  const store = await __testOnlyCreateControllerStateStore({ stateDir, markShutdownUnverified: async () => {}, limits: { maxFiles: 2, maxBytes: 8 } });
  t.after(() => store.close());
  await store.appendJournal(Buffer.from("x"));
  assert.equal(await readFile(join(stateDir, "attempts.jsonl"), "utf8"), "x");
  const secondDir = join(stateDir, "second"); await mkdir(secondDir, { mode: 0o700 });
  if (process.platform === "linux") await chmod(secondDir, 0o700);
  const blocked = await __testOnlyCreateControllerStateStore({ stateDir: secondDir, markShutdownUnverified: async () => {}, limits: { maxFiles: 1, maxBytes: 8 } });
  await blocked.replace("status.json", Buffer.from("x"));
  await assert.rejects(blocked.appendJournal(Buffer.from("x")), /CONTROLLER_STATE_QUOTA_EXCEEDED/);
  await blocked.close();
});

test("append boundary screening rejects ASCII and UTF-16 marker bytes split across journal writes", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  t.after(() => store.close());
  for (const [index, bytes] of blockedByteFixtures().entries()) {
    const prefix = bytes.subarray(0, Math.ceil(bytes.length / 2));
    await store.appendJournal(prefix);
    await assert.rejects(store.appendJournal(bytes.subarray(prefix.length)), /CONTROLLER_STATE_BLOCKED_CONTENT/);
    assert.deepEqual(await readFile(join(stateDir, "attempts.jsonl")), Buffer.concat(blockedByteFixtures().slice(0, index + 1).map(item => item.subarray(0, Math.ceil(item.length / 2)))));
  }
});

test("store rejects a symlinked managed target and any symlinked offers entry", async t => {
  const { stateDir, base } = await stateFixture(t);
  const outside = join(base, "outside");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(outside, "untouched"));
  try { await symlink(outside, join(stateDir, "status.json")); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlink creation is unavailable"); throw error; }
  await assert.rejects(createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} }), /CONTROLLER_STATE_INVALID/);
  await rm(join(stateDir, "status.json"));
  await mkdir(join(stateDir, "offers"), { mode: 0o700 });
  await symlink(outside, join(stateDir, "offers", `${modelName}.auto.json`));
  await assert.rejects(createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} }), /CONTROLLER_STATE_INVALID/);
  assert.equal((await readFile(outside, "utf8")), "untouched");
});

test("only catalog automatic prices are writable; regular offers and retired state stay untouched", async t => {
  const { stateDir } = await stateFixture(t);
  await mkdir(join(stateDir, "offers"), { mode: 0o700 });
  await mkdir(join(stateDir, "retired"), { mode: 0o700 });
  const immutable = join(stateDir, "offers", `${modelName}.json`);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(immutable, "host offer"));
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  t.after(() => store.close());
  await store.replace(`offers/${modelName}.auto.json`, Buffer.from("{}"));
  await assert.rejects(store.replace(`offers/${modelName}.json`, Buffer.from("{}")), /CONTROLLER_STATE_INVALID/);
  assert.equal(await readFile(immutable, "utf8"), "host offer");
  await store.replace(`${uuid}.result.json`, Buffer.from("result"));
  await store.removeOutput(`${uuid}.result.json`);
  assert.equal(await lstat(join(stateDir, "retired")).then(info => info.isDirectory()), true);
});

test("local broker accepts typed writes and refuses invalid peer and arbitrary routes", async t => {
  const { stateDir } = await stateFixture(t);
  let shutdownMarks = 0;
  const { socketPath } = await startBroker(t, stateDir, { mark: async () => { shutdownMarks++; } });
  const client = createControllerStateClient(socketPath);
  await client.replace("status.json", Buffer.from("{"));
  await client.appendJournal(Buffer.from("line\n"));
  await client.markShutdownUnverified();
  await client.replace(`${uuid}.result.json`, Buffer.from("temporary result"));
  await client.removeOutput(`${uuid}.result.json`);
  await assert.rejects(client.replace("control.json", Buffer.from("forbidden")), /Controller state write refused/);
  assert.equal(shutdownMarks, 1);
  await assert.rejects(readFile(join(stateDir, "control.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(stateDir, "status.json"), "utf8"), "{");
  assert.equal(await readFile(join(stateDir, "attempts.jsonl"), "utf8"), "line\n");
  assert.equal(await request(socketPath, "/v1/arbitrary"), 404);
});

test("update RPC is absent unless fixed host callbacks are configured", async t => {
  const { stateDir } = await stateFixture(t);
  const { socketPath } = await startBroker(t, stateDir);
  const client = createControllerStateClient(socketPath);
  assert.equal(await request(socketPath, "/v1/update-check"), 404);
  assert.equal(await request(socketPath, "/v1/update-install"), 404);
  await assert.rejects(client.check(null), /Controller update request refused/);
  await assert.rejects(client.install(), /Controller update request refused/);
  assert.equal(await request(socketPath, "/v1/heartbeat-sequence"), 404);
  await assert.rejects(client.nextHeartbeatSequence(), /Controller update request refused/);
  assert.equal(await request(socketPath, "/v1/arbitrary"), 404);
});

test("heartbeat RPC allocates only through the serialized host callback", async t => {
  const { stateDir } = await stateFixture(t);
  let next = 0, tail = Promise.resolve(), calls = 0;
  const { socketPath } = await startBroker(t, stateDir, { heartbeatSequence: signal => {
    calls++;
    const current = tail.then(async () => { assert.equal(signal.aborted, false); await new Promise(resolve => setTimeout(resolve, 5)); return ++next; });
    tail = current.then(() => undefined);
    return current;
  } });
  const client = createControllerStateClient(socketPath);
  const sequences = await Promise.all([client.nextHeartbeatSequence(), client.nextHeartbeatSequence(), client.nextHeartbeatSequence()]);
  assert.deepEqual([...sequences].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(calls, 3);
  assert.equal(await request(socketPath, "/v1/heartbeat-sequence", { body: Buffer.from("{}"), headers: { "content-type": "application/json" } }), 400);
  assert.equal(calls, 3);
});

test("heartbeat RPC rejects invalid host sequence values", async t => {
  const { stateDir } = await stateFixture(t);
  let calls = 0;
  const { socketPath } = await startBroker(t, stateDir, { heartbeatSequence: async () => [0, Number.MAX_SAFE_INTEGER + 1, "4"][calls++] });
  const client = createControllerStateClient(socketPath);
  for (let index = 0; index < 3; index++) await assert.rejects(client.nextHeartbeatSequence(), /Controller update request refused/);
  assert.equal(calls, 3);
});

test("closing the broker aborts an in-flight heartbeat allocator before a sequence is returned", async t => {
  const { stateDir } = await stateFixture(t);
  let entered, aborted = false;
  const started = new Promise(resolve => { entered = resolve; });
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store, validatePeer: async () => true, timeoutMs: 2000,
    heartbeatSequence: signal => new Promise((_resolve, reject) => {
      entered();
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
    }) });
  const pending = createControllerStateClient(socketPath).nextHeartbeatSequence();
  const rejected = assert.rejects(pending);
  await started;
  await broker.close();
  await rejected;
  assert.equal(aborted, true);
  await store.close();
});

test("update RPC returns only the host check and records intent without installing", async t => {
  const { stateDir } = await stateFixture(t);
  const checkedAt = new Date().toISOString();
  const fixed = { current: "1.2.3-0123456789ab", latest: "1.2.4-acde01234567", available: true, checkedAt };
  const calls = [];
  const updates = {
    async check(signal) { calls.push("check"); assert.equal(signal.aborted, false); return fixed; },
    async requestInstall(signal) { calls.push("intent"); assert.equal(signal.aborted, false); return 0; },
  };
  const { socketPath } = await startBroker(t, stateDir, { updates });
  const client = createControllerStateClient(socketPath);
  assert.deepEqual(await client.check("attacker-controlled-current"), fixed);
  assert.deepEqual(calls, ["check"]);
  assert.equal(await client.install(), 0);
  assert.deepEqual(calls, ["check", "intent"]);
});

test("fresh journal creation crosses the typed broker, while other empty mutations remain refused", async t => {
  const { stateDir } = await stateFixture(t);
  const { socketPath } = await startBroker(t, stateDir);
  const client = createControllerStateClient(socketPath);
  await client.replace("attempts.jsonl", Buffer.alloc(0));
  assert.equal((await readFile(join(stateDir, "attempts.jsonl"))).byteLength, 0);
  await assert.rejects(client.replace("status.json", Buffer.alloc(0)), /Controller state write refused/);
  await assert.rejects(client.appendJournal(Buffer.alloc(0)), /Controller state write refused/);
  assert.equal((await readFile(join(stateDir, "attempts.jsonl"))).byteLength, 0);
});

test("update RPC rejects unavailable, malformed, oversized and child-supplied metadata without intent", async t => {
  const { stateDir } = await stateFixture(t);
  let intents = 0, checks = 0;
  const { socketPath } = await startBroker(t, stateDir, { updates: {
    async check() {
      checks++;
      if (checks === 1) return { current: "1.2.3-0123456789ab", latest: "1.2.3-0123456789ab", available: false, checkedAt: new Date().toISOString() };
      if (checks === 2) return { current: null, latest: "1.2.4-acde01234567", available: true, checkedAt: new Date().toISOString(), origin: "https://invalid.test" };
      return { current: null, latest: "x".repeat(2000), available: false, checkedAt: "invalid" };
    },
    async requestInstall() { intents++; return 0; },
  } });
  const client = createControllerStateClient(socketPath);
  const unavailable = await client.check("ignored");
  assert.equal(unavailable.available, false);
  await assert.rejects(client.install(), /Controller update request refused/);
  assert.equal(await request(socketPath, "/v1/update-check", { body: Buffer.from("{}"), headers: { "content-type": "application/json" } }), 400);
  await assert.rejects(client.check(null), /Controller update request refused/);
  assert.equal(await request(socketPath, "/v1/update-install"), 409);
  await assert.rejects(client.check(null), /Controller update request refused/);
  assert.equal(intents, 0);
});

test("closing the broker aborts an in-flight host update check and drains it", async t => {
  const { stateDir } = await stateFixture(t);
  let started, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store, validatePeer: async () => true, timeoutMs: 2000, updates: {
    check: signal => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
    }),
    async requestInstall() { assert.fail("install intent must not be reached"); },
  } });
  const pending = createControllerStateClient(socketPath).check(null);
  const rejected = assert.rejects(pending);
  await entered;
  await broker.close();
  await rejected;
  assert.equal(aborted, true);
  await store.close();
});

test("untrusted peers and aborted bodies cannot mutate state", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const deniedPath = pipeName(dirname(stateDir));
  const denied = await makeBroker({ socketPath: deniedPath, store, validatePeer: async () => false });
  t.after(async () => { await denied.close(); await store.close(); });
  await assert.rejects(request(deniedPath, "/v1/replace", { body: Buffer.from("data"), name: "status.json" }));
  await assert.rejects(readFile(join(stateDir, "status.json")), { code: "ENOENT" });

  const allowedPath = pipeName(dirname(stateDir));
  const allowed = await makeBroker({ socketPath: allowedPath,
    store, validatePeer: async () => true });
  t.after(() => allowed.close());
  await new Promise(resolve => {
    const outgoing = http.request({ socketPath: allowedPath, path: "/v1/replace", method: "POST", headers: {
      "host": "localhost", "content-length": "100", "content-type": "application/octet-stream", "x-excess-state-name": "status.json",
    } });
    outgoing.once("error", () => resolve());
    outgoing.flushHeaders(); outgoing.write("part"); setTimeout(() => outgoing.destroy(), 10);
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(readFile(join(stateDir, "status.json")), { code: "ENOENT" });
});

test("broker caps concurrent active operations and propagates mark hook once per accepted request", async t => {
  const { stateDir } = await stateFixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => { calls++; await blocked; } });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store,
    validatePeer: async () => true, timeoutMs: 5000 });
  t.after(async () => { release(); await broker.close(); await store.close(); });
  const pending = Array.from({ length: 8 }, () => request(socketPath, "/v1/mark-shutdown-unverified"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 1); // the host store serializes callbacks; seven calls await its lock
  const overflow = await request(socketPath, "/v1/mark-shutdown-unverified");
  assert.equal(overflow, 503);
  release();
  assert.deepEqual(await Promise.all(pending), Array(8).fill(204));
  assert.equal(calls, 8);
});

test("broker reserves aggregate request bytes before buffering bodies", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store,
    validatePeer: async () => true, timeoutMs: 5000, inFlightByteLimit: 8 * 1024 * 1024 });
  t.after(async () => { await broker.close(); await store.close(); });
  const first = http.request({ socketPath, path: "/v1/replace", method: "POST", headers: {
    host: "localhost", "content-length": String(6 * 1024 * 1024), "content-type": "application/octet-stream", "x-excess-state-name": "status.json",
  } });
  first.once("error", () => {}); first.flushHeaders(); first.write(Buffer.alloc(1024 * 1024));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await request(socketPath, "/v1/append-journal", { body: Buffer.alloc(3 * 1024 * 1024) }), 503);
  first.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(readFile(join(stateDir, "status.json")), { code: "ENOENT" });
});

test("a hanging peer validator is aborted by the broker deadline and close reaps the socket", async t => {
  const { stateDir } = await stateFixture(t);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const socketPath = pipeName(dirname(stateDir));
  const broker = await makeBroker({ socketPath, store, validatePeer: async () => new Promise(() => {}), timeoutMs: 50 });
  const pending = request(socketPath, "/v1/mark-shutdown-unverified");
  await assert.rejects(pending);
  await broker.close();
  await store.close();
  assert.deepEqual((await readdir(stateDir)).sort(), []);
});
