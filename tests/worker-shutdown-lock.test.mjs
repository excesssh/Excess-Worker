import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireRuntimeLock, setWorkerControl, readWorkerControl, readWorkerStatus } from "../apps/worker/dist/control.js";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { runLocalProbe } from "../apps/worker/dist/probe.js";
import { capabilityDigest, TEXT_CAPABILITY } from "../packages/adapters/dist/index.js";
import { createFixtureScratch } from "./helpers/fixture-scratch.mjs";

// Fake stop rejection is deliberately unresolved process evidence, not a real
// model failure. The only child spawned here runs the lock helper and exits.
const live = new Set();
const scratchDirectories = new Set();
afterEach(async () => {
  const pending = [...live]; live.clear();
  for (const fixture of pending) fixture.shutdown.abort();
  await Promise.allSettled(pending.map(fixture => fixture.operation));
  const scratches = [...scratchDirectories]; scratchDirectories.clear();
  for (const scratch of scratches) await scratch.cleanup();
});
async function directory() { const scratch = await createFixtureScratch("worker-shutdown-fixture-"); scratchDirectories.add(scratch); return scratch.path; }
const readLock = async dir => JSON.parse(await readFile(join(dir, "runtime.lock"), "utf8"));
const policy = { threads: 1, maxMemoryMb: 1024, runSeconds: 5, idleOnly: false, idleSeconds: 60 };
const telemetry = async () => ({ freeMemoryMb: 8192, idleSeconds: 120 });
function adapter(failStop) {
  let probes = 0;
  return {
    probes: () => probes,
    async probe() { probes++; return { ok: true, capabilityDigest, backend: "cpu", model: TEXT_CAPABILITY.model, runtime: TEXT_CAPABILITY.runtime,
      threads: 1, maxMemoryMb: 1024, probedAt: new Date().toISOString(), generatedTokens: 1, peakRssMb: 1 }; },
    async execute() { throw Error("No synthetic assignment expected"); },
    async stop() { if (failStop) throw Error("SYNTHETIC UNVERIFIED SHUTDOWN"); },
  };
}
async function waitFor(check) { const until = Date.now() + 5000; while (!await check()) { assert.ok(Date.now() < until, "fixture started"); await new Promise(resolve => setTimeout(resolve, 10)); } }

test("shutdown marker preserves lock ownership and blocks ordinary release or reacquisition", async () => {
  const dir = await directory(), lock = await acquireRuntimeLock(dir), before = await readLock(dir);
  await lock.markShutdownUnverified(); await lock.markShutdownUnverified();
  const after = await readLock(dir);
  assert.equal(after.pid, before.pid); assert.equal(after.nonce, before.nonce); assert.equal(after.shutdownUnverified, true);
  assert.ok(Number.isFinite(Date.parse(after.shutdownUnverifiedAt)));
  await assert.rejects(lock(), /shutdown unverified/);
  await assert.rejects(acquireRuntimeLock(dir), /shutdown unverified/);
  assert.deepEqual(await readLock(dir), after);
  assert.equal((await readWorkerStatus(dir)).reason, "adapter_stop_failed");
});

test("a dead owner cannot clear a flagged lock; ordinary legacy dead-owner recovery still works", async () => {
  for (const flagged of [true, false]) {
    const dir = await directory();
    const source = `import {acquireRuntimeLock} from ${JSON.stringify(new URL("../apps/worker/dist/control.js", import.meta.url).href)};
      const lock=await acquireRuntimeLock(process.argv[1]);${flagged ? "await lock.markShutdownUnverified();" : ""}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", value => { stderr += value; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr);
    const owner = await readLock(dir); assert.equal(owner.pid, child.pid);
    assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
    if (flagged) { await assert.rejects(acquireRuntimeLock(dir), /shutdown unverified/); assert.deepEqual(await readLock(dir), owner); }
    else { const recovered = await acquireRuntimeLock(dir); await recovered(); const next = await acquireRuntimeLock(dir); await next(); }
  }
});

test("a zombie owner (killed, not yet reaped by its parent) does not hold the lock on Linux", { skip: process.platform !== "linux" }, async () => {
  const dir = await directory();
  // The shell starts a short child, then replaces itself with a sleep that never reaps it: the child stays a zombie.
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
  const zombie = Number(await new Promise(resolve => parent.stdout.once("data", value => resolve(String(value).trim()))));
  try {
    await waitFor(async () => { try { return (await readFile(`/proc/${zombie}/stat`, "utf8")).split(") ")[1].startsWith("Z"); } catch { return false; } });
    await writeFile(join(dir, "runtime.lock"), JSON.stringify({ pid: zombie, nonce: randomUUID() }), { mode: 0o600 });
    const lock = await acquireRuntimeLock(dir);
    assert.equal((await readLock(dir)).pid, process.pid);
    await lock();
    // A live owner still holds it.
    await writeFile(join(dir, "runtime.lock"), JSON.stringify({ pid: parent.pid, nonce: randomUUID() }), { mode: 0o600 });
    await assert.rejects(acquireRuntimeLock(dir), /already running/);
  } finally { parent.kill(); }
});

for (const failStop of [true, false]) test(`synthetic worker ${failStop ? "rejects failed shutdown and retains" : "completes verified shutdown and releases"} its foreground lock`, async () => {
  const dir = await directory(), fake = adapter(failStop), heartbeats = [], shutdown = new AbortController();
  const connection = { deviceId: randomUUID(), async heartbeat(value) { heartbeats.push(value); return { accepted: true }; },
    async command(type) { assert.equal(type, "worker.poll"); return { executionEnabled: false, assignments: [] }; } };
  const options = { stateDir: dir, identityPath: join(dir, "unused.json"), installDir: "NO_MODEL_INSTALLED", adapter: fake, connection, telemetry, policy,
    signal: shutdown.signal, timings: { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 } };
  await setWorkerControl(dir, "run");
  const operation = runWorker(options); live.add({ shutdown, operation });
  const rejected = failStop ? assert.rejects(operation, { code: "ADAPTER_STOP_FAILED" }) : null;
  await waitFor(() => fake.probes() > 0); await setWorkerControl(dir, "stop");
  if (rejected) await rejected; else assert.equal((await operation).state, "stopped");
  assert.equal(await readWorkerControl(dir), "stop");
  assert.equal(heartbeats.at(-1).availableSlots, 0); assert.deepEqual(heartbeats.at(-1).capabilityDigests, []);
  if (failStop) {
    const status = await readWorkerStatus(dir);
    assert.equal(status.state, "error"); assert.equal(status.reason, "adapter_stop_failed"); assert.equal(status.capabilityDigest, null);
    assert.equal((await readLock(dir)).shutdownUnverified, true);
    await assert.rejects(runWorker(options), /shutdown unverified/);
  } else { const reacquired = await acquireRuntimeLock(dir); await reacquired(); }
});

test("synthetic standalone probe rejects unverified shutdown and retains the same inspection barrier", async () => {
  const dir = await directory();
  await assert.rejects(runLocalProbe({ stateDir: dir, installDir: "NO_MODEL_INSTALLED", adapter: adapter(true), policy, telemetry }), { code: "ADAPTER_STOP_FAILED" });
  assert.equal((await readLock(dir)).shutdownUnverified, true);
  assert.equal((await readWorkerStatus(dir)).reason, "adapter_stop_failed"); assert.equal(await readWorkerControl(dir), "stop");
  await assert.rejects(acquireRuntimeLock(dir), /shutdown unverified/);
});
