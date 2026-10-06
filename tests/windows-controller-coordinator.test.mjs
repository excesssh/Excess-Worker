import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWindowsCoordinatorHost, createWindowsCoordinatorClient } from "../apps/worker/dist/windows-controller-coordinator.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { capabilityDigest } from "../packages/adapters/dist/index.js";

const signal = () => new AbortController().signal;
function fixture(overrides = {}, hostOptions = {}) {
  const calls = [], deviceId = randomUUID(), offers = [];
  const connection = { deviceId, origin: "https://coordinator.example", privateKey: "not exposed fixture sentinel",
    heartbeat: async value => { calls.push(["heartbeat", value]); return { accepted: true }; },
    command: async (type, value) => { calls.push([type, value]); return { accepted: true }; },
    offer: async value => { calls.push(["offer", value]); return { accepted: true }; }, ...overrides };
  const host = createWindowsCoordinatorHost({ connection, capabilityDigest,
    fetcher: async target => { calls.push(["fetch", String(target)]); return new Response('{"markets":[]}'); },
    telemetry: async () => ({ freeMemoryMb: 4096, idleSeconds: 120, onBattery: false }), readOffers: async () => offers, ...hostOptions });
  const sentPayloads = [];
  return { host, calls, deviceId, offers, sentPayloads,
    client: () => createWindowsCoordinatorClient((payload, abort) => { sentPayloads.push(payload); return host.handle(payload, abort ?? signal()); }) };
}

test("host metadata exposes only public pairing fields and accepts the fixed runtime operations", async () => {
  const f = fixture();
  try {
    const metadata = await f.host.handle({ action: "metadata" }, signal());
    assert.deepEqual(Object.keys(metadata.value).sort(), ["capabilityDigest", "deviceId", "origin"]);
    const c = await f.client(); assert.equal(c.connection.deviceId, f.deviceId);
    assert.deepEqual(await c.connection.heartbeat({ totalSlots: 1, availableSlots: 1, capabilityDigests: [capabilityDigest] }), { accepted: true });
    assert.deepEqual(await c.connection.command("worker.poll", {}), { accepted: true });
    assert.deepEqual(await c.telemetry(), { freeMemoryMb: 4096, idleSeconds: 120, onBattery: false });
    assert.deepEqual(await (await c.fetcher("https://coordinator.example/v1/market", { redirect: "error" })).json(), { markets: [] });
  } finally { f.host.close(); }
});

test("invalid routes, signing envelopes, identity overrides, capacities and capabilities never reach the connection", async () => {
  const f = fixture();
  try {
    for (const payload of [{ action: "fetch", url: "https://other.example" }, { action: "metadata", url: "https://other.example" },
      { action: "command", type: "worker.heartbeat", data: {} }, { action: "command", type: "worker.poll", data: { deviceId: randomUUID() } },
      { action: "command", type: "job.input", data: { jobId: randomUUID() } },
      { action: "heartbeat", capacity: { totalSlots: 2, availableSlots: 2, capabilityDigests: [capabilityDigest] } },
      { action: "heartbeat", capacity: { totalSlots: 1, availableSlots: 1, capabilityDigests: [] } },
      { action: "offer", data: { capabilityDigest: "0".repeat(64), slots: 1 } }])
      await assert.rejects(f.host.handle(payload, signal()), /CONTROLLER_COORDINATOR_INVALID/);
    assert.equal(f.calls.length, 0);
    const c = await f.client();
    await assert.rejects(c.fetcher("https://other.example/v1/market"), /CONTROLLER_COORDINATOR_INVALID/);
    await assert.rejects(c.fetcher("https://coordinator.example/v1/market", { method: "POST" }), /CONTROLLER_COORDINATOR_INVALID/);
  } finally { f.host.close(); }
});

test("HTTP revocation remains a typed connection error and private exception details are discarded", async () => {
  const f = fixture({ command: async () => { throw new WorkerConnectionError(403); } });
  try { const c = await f.client(); await assert.rejects(c.connection.command("worker.poll", {}), error => error instanceof WorkerConnectionError && error.status === 403); }
  finally { f.host.close(); }
  const bad = fixture({ command: async () => { throw Error("fixture secret detail"); } });
  try { const c = await bad.client(); await assert.rejects(c.connection.command("worker.poll", {}), /^Error: CONTROLLER_COORDINATOR_INVALID$/); }
  finally { bad.host.close(); }
});

test("host close aborts an outstanding request and refuses later requests", async () => {
  let entered = false;
  const f = fixture({ command: (_, __, abort) => new Promise((resolve, reject) => { entered = true; abort.addEventListener("abort", () => reject(new WorkerConnectionError(null)), { once: true }); }) });
  const c = await f.client(), request = c.connection.command("worker.poll", {}); assert.equal(entered, true);
  await f.host.close(); await assert.rejects(request, error => error instanceof WorkerConnectionError);
  await assert.rejects(c.connection.command("worker.poll", {}), /CONTROLLER_COORDINATOR_INVALID/);
});

test("host shutdown waits for an aborted command to finish before releasing its authority", async () => {
  let release, aborted = false;
  const f = fixture({ command: (_, __, abort) => new Promise(resolve => {
    release = () => resolve({ accepted: true });
    abort.addEventListener("abort", () => { aborted = true; }, { once: true });
  }) });
  const c = await f.client(), request = c.connection.command("worker.poll", {});
  let closed = false; const closing = f.host.close().then(() => { closed = true; });
  assert.equal(aborted, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await request; await closing; assert.equal(closed, true);
});

test("offer signing follows host configuration and automatic price bounds", async () => {
  const f = fixture(), assetId = randomUUID(), probedAt = new Date().toISOString();
  const payload = netUnits => ({ action: "offer", data: { capabilityDigest, assetId, slots: 1, probedAt, netUnits } });
  try {
    await assert.rejects(f.host.handle(payload("1"), signal()), /INVALID/);
    f.offers.push({ assetId, netUnits: "1" });
    await f.host.handle(payload("1"), signal());
    await assert.rejects(f.host.handle(payload("2"), signal()), /INVALID/);
    Object.assign(f.offers[0], { auto: "follow_lowest", minNetUnits: "0.5", maxNetUnits: "2" });
    await f.host.handle(payload("0.75"), signal());
    for (const value of ["0.4", "2.1"]) await assert.rejects(f.host.handle(payload(value), signal()), /INVALID/);
    assert.equal(f.calls.filter(call => call[0] === "offer").length, 2);
    f.offers.length = 0; await assert.rejects(f.host.handle(payload("1"), signal()), /INVALID/);
  } finally { await f.host.close(); }
});

const currentRelease = "1.2.3-0123456789ab";
const latestRelease = "1.3.0-abcdef012345";
const validUpdate = () => ({ current: currentRelease, latest: latestRelease, available: true, checkedAt: "2026-10-06T00:00:00.000Z" });

test("update check is a no-payload typed host operation using captured pairing and package state", async () => {
  const calls = [], update = { current: currentRelease, check: async (...args) => { calls.push(args); return validUpdate(); } };
  const f = fixture({}, { update });
  update.current = null;
  update.check = async () => { throw Error("mutated update callback"); };
  try {
    for (const payload of [{ action: "update.check", origin: "https://other.example" }, { action: "update.check", url: "https://other.example" },
      { action: "update.check", current: latestRelease }, { action: "update.check", installerCommand: "setup.exe" }])
      await assert.rejects(f.host.handle(payload, signal()), /CONTROLLER_COORDINATOR_INVALID/);
    assert.equal(calls.length, 0);
    const c = await f.client();
    assert.deepEqual(await c.checkForUpdate(signal()), validUpdate());
    assert.deepEqual(f.sentPayloads.at(-1), { action: "update.check" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://coordinator.example");
    assert.equal(calls[0][1], currentRelease);
    assert.ok(calls[0][2] instanceof AbortSignal);
    assert.deepEqual(f.calls, []);
  } finally { await f.host.close(); }
});

test("update check rejects malformed, extra, inconsistent and stale host results at both boundaries", async () => {
  const oversizedVersion = "1.3.0-" + "a".repeat(65537) + "-abcdef012345";
  const malformed = [
    () => ({ ...validUpdate(), unexpected: true }),
    () => ({ ...validUpdate(), latest: "latest" }),
    () => ({ ...validUpdate(), available: false }),
    () => ({ ...validUpdate(), current: "9.9.9-abcdef012345" }),
    () => ({ ...validUpdate(), latest: oversizedVersion }),
    () => ({ ...validUpdate(), checkedAt: "2026-02-30T12:00:00.000Z" }),
  ];
  for (const result of malformed) {
    const f = fixture({}, { update: { current: currentRelease, check: async () => result() } });
    try { await assert.rejects(f.host.handle({ action: "update.check" }, signal()), /CONTROLLER_COORDINATOR_INVALID/); }
    finally { await f.host.close(); }
  }
  const malformedClient = fixture();
  try {
    const client = await createWindowsCoordinatorClient(async payload => payload.action === "metadata"
      ? { ok: true, value: { deviceId: randomUUID(), origin: "https://coordinator.example", capabilityDigest } }
      : { ok: true, value: { ...validUpdate(), unexpected: true } });
    await assert.rejects(client.checkForUpdate(signal()), /CONTROLLER_COORDINATOR_INVALID/);
    const oversizedClient = await createWindowsCoordinatorClient(async payload => payload.action === "metadata"
      ? { ok: true, value: { deviceId: randomUUID(), origin: "https://coordinator.example", capabilityDigest } }
      : { ok: true, value: { ...validUpdate(), latest: oversizedVersion } });
    await assert.rejects(oversizedClient.checkForUpdate(signal()), /CONTROLLER_COORDINATOR_INVALID/);
  } finally { await malformedClient.host.close(); }
});

test("source builds cannot start a signed update check", async () => {
  let called = false;
  const f = fixture({}, { update: { current: null, check: async () => { called = true; return validUpdate(); } } });
  try {
    await assert.rejects(f.host.handle({ action: "update.check" }, signal()), /CONTROLLER_COORDINATOR_INVALID/);
    assert.equal(called, false);
    assert.equal(f.calls.length, 0);
  } finally { await f.host.close(); }
});

test("host close aborts and drains a signed update check", async () => {
  let entered = false, aborted = false, release;
  const f = fixture({}, { update: { current: currentRelease, check: (_, __, abort) => new Promise(resolve => {
    entered = true; release = () => resolve(validUpdate());
    abort.addEventListener("abort", () => { aborted = true; }, { once: true });
  }) } });
  const request = f.host.handle({ action: "update.check" }, signal());
  assert.equal(entered, true);
  let closed = false; const closing = f.host.close().then(() => { closed = true; });
  assert.equal(aborted, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await request; await closing; assert.equal(closed, true);
});
