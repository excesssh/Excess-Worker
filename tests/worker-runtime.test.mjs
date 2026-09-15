import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, access, unlink, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { setWorkerControl, readWorkerControl, readWorkerStatus, acquireRuntimeLock } from "../apps/worker/dist/control.js";
import { parseWorkerPolicy, policyDecision, readWorkerPolicy, writeWorkerPolicy } from "../apps/worker/dist/policy.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { capabilityDigest, TEXT_CAPABILITY } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";

const policy = { threads: 1, maxMemoryMb: 1024, runSeconds: 2, idleOnly: false, idleSeconds: 60, model: "qwen3-4b", backend: "cpu" };
const timings = { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 };
const output = { text: "TEST FIXTURE OUTPUT", generatedTokens: 3, finishReason: "stop" };
const ready = { freeMemoryMb: 8192, idleSeconds: 120 };
const liveFixtures = new Set();
afterEach(async () => {
  const fixtures = [...liveFixtures]; liveFixtures.clear();
  // Abort independently of control-file writes so an assertion or filesystem
  // failure cannot leave a foreground fixture alive and hang the test process.
  for (const f of fixtures) f.shutdown.abort();
  await Promise.allSettled(fixtures.map(f => setWorkerControl(f.dir, "stop")));
  await Promise.allSettled(fixtures.flatMap(f => [...f.operations]));
});
const waitFor = async (check, message = "condition") => {
  const until = Date.now() + 5000;
  while (!await check()) { if (Date.now() > until) throw Error("Timed out: " + message); await new Promise(r => setTimeout(r, 10)); }
};
async function fixture() {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/worker-runtime-fixture-"));
  const shutdown = new AbortController(), operations = new Set();
  liveFixtures.add({ dir, shutdown, operations });
  const request = { prompt: "TEST FIXTURE INPUT", maxTokens: 8, seed: 42 };
  const deviceId = randomUUID();
  const a = { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), runDeadlineAt: new Date(Date.now() + 90000).toISOString(),
    offerId: randomUUID(), capabilityDigest, requestDigest: requestDigest(request), maxUnits: "8" };
  const state = { assigned: true, failHeartbeat: null, failRenew: null, ignoreFailure: false, loseResult: false, acceptedResult: false, badInput: false };
  const calls = [], heartbeats = [];
  const connection = {
    deviceId,
    async heartbeat(value) {
      heartbeats.push(structuredClone(value));
      if (state.failHeartbeat) throw state.failHeartbeat;
      return { accepted: true, executionEnabled: false };
    },
    async command(type, data) {
      calls.push({ type, data: structuredClone(data) });
      if (type === "worker.poll") return { executionEnabled: state.assigned, assignments: state.assigned ? [a] : [] };
      if (type === "job.input") return { request: state.badInput ? { ...request, prompt: "wrong" } : request, requestDigest: a.requestDigest, capabilityDigest };
      if (type === "job.started") return { state: "running", leaseExpiresAt: a.leaseExpiresAt };
      if (type === "job.renew") { if (state.failRenew) { const error = state.failRenew; state.failRenew = null; throw error; } return { state: "running", leaseExpiresAt: a.leaseExpiresAt }; }
      if (type === "job.failed") { if (!state.ignoreFailure) state.assigned = false; return { state: "failed" }; }
      if (type === "job.result") {
        assert.equal(data.outputDigest, requestDigest(data.output));
        assert.equal(data.reportedUnits, String(data.output.generatedTokens));
        state.acceptedResult = true; state.assigned = false;
        if (state.loseResult) { state.loseResult = false; throw new WorkerConnectionError(null); }
        return { accepted: true, state: "verifying" };
      }
      throw Error("Unknown test command");
    },
  };
  let complete;
  const counts = { probes: 0, executions: 0, aborts: 0, stops: 0 }, probes = [];
  const adapter = {
    async probe() {
      counts.probes++;
      // Explicit synthetic adapter observation for schema/persistence tests only.
      // These process IDs and memory/token values are not hardware evidence.
      const proof = { ok: true, capabilityDigest, backend: "cpu", model: TEXT_CAPABILITY.model, runtime: TEXT_CAPABILITY.runtime,
        threads: policy.threads, maxMemoryMb: policy.maxMemoryMb, probedAt: new Date().toISOString(),
        generatedTokens: 3, peakRssMb: 256, nativePid: 700001, guardianPid: 700002 };
      probes.push(proof); return proof;
    },
    async execute(value, { signal }) {
      assert.deepEqual(value, request);
      counts.executions++;
      return new Promise((resolve, reject) => {
        const aborted = () => { counts.aborts++; reject(Error("TEST FIXTURE ABORT")); };
        signal.addEventListener("abort", aborted, { once: true });
        complete = result => { signal.removeEventListener("abort", aborted); resolve(result); };
        if (signal.aborted) aborted();
      });
    },
    async stop() { counts.stops++; },
  };
  const start = (extra = {}) => {
    const operation = (async () => {
      await setWorkerControl(dir, "run");
      return runWorker({ identityPath: join(dir, "unused-identity.json"), stateDir: dir,
        installDir: join(dir, "NO_MODEL_INSTALLED"), policy, timings, connection, adapter, telemetry: async () => ready, ...extra,
        signal: extra.signal ? AbortSignal.any([shutdown.signal, extra.signal]) : shutdown.signal });
    })();
    operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  };
  const journal = async () => (await readFile(join(dir, "attempts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { dir, a, state, connection, adapter, calls, heartbeats, counts, probes, start, journal, complete: result => complete(result) };
}

test("worker policy and controls fail closed and fence concurrent foreground runtimes", async () => {
  assert.equal(parseWorkerPolicy({}).idleOnly, true);
  for (const value of [{ threads: 0 }, { threads: 65 }, { maxMemoryMb: 512 }, { maxMemoryMb: 262145 }, { model: "not-in-catalog" }, { backend: "rocm" }, { runSeconds: 121 }, { idleOnly: "false" }, { gpu: true }]) assert.throws(() => parseWorkerPolicy(value));
  assert.equal(policyDecision({ ...policy, idleOnly: true }, { ...ready, idleSeconds: null }).reason, "idle_observation_unavailable");
  assert.equal(policyDecision(policy, { ...ready, freeMemoryMb: null }).allowed, false);
  assert.equal(policyDecision(policy, { ...ready, freeMemoryMb: 100 }).allowed, false);
  const f = await fixture();
  assert.equal(await readWorkerControl(f.dir), "stop");
  assert.deepEqual(await writeWorkerPolicy(f.dir, policy), policy);
  assert.deepEqual(await readWorkerPolicy(f.dir), policy);
  const releases = await Promise.allSettled([acquireRuntimeLock(f.dir), acquireRuntimeLock(f.dir)]);
  assert.equal(releases.filter(r => r.status === "fulfilled").length, 1);
  await releases.find(r => r.status === "fulfilled").value();
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  await once(child, "exit");
  await writeFile(join(f.dir, "runtime.lock"), JSON.stringify({ pid: child.pid, nonce: "DEAD TEST OWNER" }));
  const recovered = await Promise.allSettled([acquireRuntimeLock(f.dir), acquireRuntimeLock(f.dir), acquireRuntimeLock(f.dir)]);
  assert.equal(recovered.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(JSON.parse(await readFile(join(f.dir, "runtime.lock"), "utf8")).pid, process.pid);
  await recovered.find(r => r.status === "fulfilled").value();
  await writeFile(join(f.dir, "status.json"), JSON.stringify({ version: 1, state: "running", reason: "fixture", updatedAt: new Date().toISOString() }));
  assert.equal((await readWorkerStatus(f.dir)).state, "stale");
});

test("atomic worker controls remain complete during concurrent reads and Windows replacement contention", async () => {
  const f = await fixture();
  await setWorkerControl(f.dir, "stop");
  let reading = true, observed = 0;
  const readers = Array.from({ length: 6 }, async () => {
    while (reading) {
      assert.ok(["run", "drain", "stop"].includes(await readWorkerControl(f.dir)));
      observed++;
      await new Promise(resolve => setImmediate(resolve));
    }
  });
  const readResults = Promise.allSettled(readers);
  let writes;
  try {
    writes = await Promise.allSettled(Array.from({ length: 4 }, async (_, writer) => {
      for (let n = 0; n < 30; n++) await setWorkerControl(f.dir, ["run", "drain", "stop"][(n + writer) % 3]);
    }));
  } finally { reading = false; }
  const reads = await readResults;
  assert.ok(observed >= 100);
  assert.ok(writes.every(result => result.status === "fulfilled"), JSON.stringify(writes));
  assert.ok(reads.every(result => result.status === "fulfilled"), JSON.stringify(reads));
  await setWorkerControl(f.dir, "stop");
  assert.equal(await readWorkerControl(f.dir), "stop");
  assert.ok(!(await readdir(f.dir)).some(name => name.startsWith("control.json.pending-")));
  if (process.platform === "win32") {
    // A separate process deliberately holds a Windows read handle that denies
    // replacement, proving retry works beyond the in-process serialization.
    const script = '$taskFile=[IO.File]::Open($env:EXCESS_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine("READY"); [Threading.Thread]::Sleep(150); $taskFile.Dispose()';
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, EXCESS_TEST_LOCK_PATH: join(f.dir, "control.json") },
    });
    const exited = once(child, "exit");
    await once(child.stdout, "data");
    try { await setWorkerControl(f.dir, "drain"); }
    finally { await exited; }
    assert.equal(await readWorkerControl(f.dir), "drain");
    assert.ok(!(await readdir(f.dir)).some(name => name.startsWith("control.json.pending-")));
  }
});

test("fixture worker drain finishes one execution, receipts output and withdraws capacity", async () => {
  const f = await fixture(), running = f.start();
  await waitFor(() => f.counts.executions === 1);
  const observation = { ...f.probes[0], policy };
  assert.deepEqual((await readWorkerStatus(f.dir)).lastProbe, observation);
  await setWorkerControl(f.dir, "drain");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(f.counts.aborts, 0);
  f.complete(output);
  const result = await running;
  assert.equal(result.reason, "drained");
  assert.equal(f.counts.executions, 1);
  assert.deepEqual((await f.journal()).map(e => e.state), ["seen", "running", "result_pending", "finished"]);
  await assert.rejects(access(join(f.dir, f.a.attemptId + ".result.json")), { code: "ENOENT" });
  assert.deepEqual(f.heartbeats.at(-1), { totalSlots: 1, availableSlots: 0, capabilityDigests: [] });
  const status = await readWorkerStatus(f.dir);
  assert.equal(status.state, "stopped");
  assert.deepEqual(status.lastProbe, observation);
});

test("fixture worker stop-now aborts and a repeated assignment cannot execute after restart", async () => {
  const f = await fixture(); f.state.ignoreFailure = true;
  const running = f.start();
  await waitFor(() => f.counts.executions === 1);
  await setWorkerControl(f.dir, "stop");
  await running;
  assert.equal(f.counts.aborts, 1);
  assert.equal((await f.journal()).at(-1).state, "abandoned");
  assert.ok(f.calls.some(c => c.type === "job.failed" && c.data.reason === "cancelled_locally"));
  const failures = f.calls.filter(c => c.type === "job.failed").length;
  const resumed = f.start();
  await waitFor(() => f.calls.filter(c => c.type === "job.failed").length > failures);
  await setWorkerControl(f.dir, "stop"); await resumed;
  assert.equal(f.counts.executions, 1);
  assert.equal(f.heartbeats.at(-1).availableSlots, 0);
});

test("fixture journal recovery abandons interrupted execution and removes orphan output", async () => {
  const f = await fixture();
  const lines = ["seen", "running"].map(state => JSON.stringify({ assignment: f.a, state, reason: "TEST FIXTURE", updatedAt: new Date().toISOString() }));
  await writeFile(join(f.dir, "attempts.jsonl"), lines.join("\n") + "\n{torn", { mode: 0o600 });
  await writeFile(join(f.dir, f.a.attemptId + ".result.json"), JSON.stringify(output), { mode: 0o600 });
  const running = f.start();
  await waitFor(() => f.calls.some(c => c.type === "job.failed"));
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal(f.counts.executions, 0);
  assert.equal((await f.journal()).at(-1).state, "abandoned");
  await assert.rejects(access(join(f.dir, f.a.attemptId + ".result.json")), { code: "ENOENT" });
});

test("fixture pending result survives restart and retries lost receipt without executing", async () => {
  const f = await fixture();
  f.state.assigned = false; f.state.loseResult = true;
  const lines = ["seen", "running", "result_pending"].map(state => JSON.stringify({ assignment: f.a, state, reason: "TEST FIXTURE",
    updatedAt: new Date().toISOString(), ...(state === "result_pending" ? { resultDigest: requestDigest(output) } : {}) }));
  await writeFile(join(f.dir, "attempts.jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
  await writeFile(join(f.dir, f.a.attemptId + ".result.json"), JSON.stringify(output), { mode: 0o600 });
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1).state === "finished");
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal(f.counts.executions, 0);
  assert.equal(f.calls.filter(c => c.type === "job.result").length, 2);
  await assert.rejects(access(join(f.dir, f.a.attemptId + ".result.json")), { code: "ENOENT" });
});

test("fixture worker never probes with unavailable idle observation and aborts when user returns", async () => {
  const blocked = await fixture(); blocked.state.assigned = false;
  const waiting = blocked.start({ policy: { ...policy, idleOnly: true }, telemetry: async () => ({ ...ready, idleSeconds: null }) });
  await waitFor(() => blocked.heartbeats.length >= 3);
  await setWorkerControl(blocked.dir, "stop"); await waiting;
  assert.equal(blocked.counts.probes, 0); assert.equal(blocked.counts.executions, 0);
  assert.equal((await readWorkerStatus(blocked.dir)).lastProbe, undefined);
  assert.ok(blocked.heartbeats.every(h => h.availableSlots === 0 && h.capabilityDigests.length === 0));
  const f = await fixture(); let idleSeconds = 120;
  const running = f.start({ policy: { ...policy, idleOnly: true }, telemetry: async () => ({ ...ready, idleSeconds }) });
  await waitFor(() => f.counts.executions === 1);
  idleSeconds = 0;
  await waitFor(() => f.counts.aborts === 1);
  await waitFor(() => f.calls.some(c => c.type === "job.failed"));
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal((await f.journal()).at(-1).state, "abandoned");
});

test("fixture worker aborts on lost lease renewal or revoked identity and requires reconciliation", async () => {
  const f = await fixture();
  const running = f.start();
  await waitFor(() => f.counts.executions === 1);
  f.state.failRenew = new WorkerConnectionError(null);
  await waitFor(() => f.counts.aborts === 1);
  await waitFor(() => f.calls.some(c => c.type === "job.failed"));
  await waitFor(() => f.calls.filter(c => c.type === "worker.poll").length >= 2);
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal(f.counts.executions, 1);
  const revoked = await fixture(), active = revoked.start();
  await waitFor(() => revoked.counts.executions === 1);
  revoked.state.failHeartbeat = new WorkerConnectionError(401, "DEVICE_UNAUTHORIZED");
  const result = await active;
  assert.equal(result.state, "revoked");
  assert.equal(revoked.counts.aborts, 1);
  assert.equal(await readWorkerControl(revoked.dir), "stop");
});

test("fixture worker rejects input digest mismatch without invoking executor", async () => {
  const f = await fixture(); f.state.badInput = true;
  const running = f.start();
  await waitFor(() => f.calls.some(c => c.type === "job.failed"));
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal(f.counts.executions, 0);
  assert.equal((await f.journal()).at(-1).state, "abandoned");
  await unlink(join(f.dir, "attempts.jsonl"));
  await assert.rejects(f.start(), /attempt journal missing/);
  assert.equal(f.counts.executions, 0);
});

test("fixture idle worker withdraws advertised capacity and stop interrupts an outstanding poll", async () => {
  const f = await fixture(); f.state.assigned = false;
  const running = f.start();
  await waitFor(() => f.heartbeats.some(h => h.availableSlots === 1));
  const original = f.connection.command;
  let polling = false;
  f.connection.command = async (type, data, signal) => {
    if (type !== "worker.poll") return original(type, data, signal);
    polling = true;
    return new Promise((_, reject) => {
      const abort = () => reject(new WorkerConnectionError(null));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  await waitFor(() => polling);
  await setWorkerControl(f.dir, "stop");
  assert.equal((await running).state, "stopped");
  assert.equal(f.counts.executions, 0);
  assert.deepEqual(f.heartbeats.at(-1), { totalSlots: 1, availableSlots: 0, capabilityDigests: [] });
});

test("fixture worker publishes its configured offer only after a probe, and a refused offer retries without disconnecting", async () => {
  const f = await fixture(); f.state.assigned = false;
  const assetId = randomUUID(), offers = [];
  let refuse = 1;
  f.connection.offer = async data => {
    offers.push(structuredClone(data));
    if (refuse > 0) { refuse--; throw new WorkerConnectionError(409); }
    return { published: true, offerId: randomUUID() };
  };
  const running = f.start({ offer: { assetId, netUnits: "5" } });
  await waitFor(() => offers.length >= 2, "offer retried after refusal");
  assert.ok(f.counts.probes >= 1);
  assert.deepEqual(offers[1], { capabilityDigest, assetId, netUnits: "5", slots: 1, probedAt: f.probes[0].probedAt });
  assert.ok(!f.heartbeats.some(h => h.capabilityDigests.length === 0 && h.availableSlots === 1));
  await setWorkerControl(f.dir, "stop");
  assert.equal((await running).state, "stopped", "an offer refusal is not a disconnect or fatal error");

  const quiet = await fixture(); quiet.state.assigned = false;
  let published = 0;
  quiet.connection.offer = async () => { published++; return { published: true }; };
  const idle = quiet.start({ offer: null });
  await waitFor(() => quiet.heartbeats.some(h => h.availableSlots === 1));
  await setWorkerControl(quiet.dir, "stop");
  await idle;
  assert.equal(published, 0, "a worker without a configured price publishes nothing");
});

test("fixture malformed probe observations never become retained evidence or advertised capability", async () => {
  for (const invalid of [
    { capabilityDigest: "0".repeat(64) }, { backend: "gpu" }, { runtime: "unrelated runtime" },
    { threads: 2 }, { generatedTokens: 9 }, { peakRssMb: NaN }, { nativePid: 0 }, { guardianPid: -1 },
    { probedAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    const f = await fixture(); f.state.assigned = false;
    const original = f.adapter.probe;
    f.adapter.probe = async () => ({ ...await original(), ...invalid });
    assert.equal((await f.start()).state, "error");
    assert.equal(f.counts.executions, 0);
    assert.equal((await readWorkerStatus(f.dir)).lastProbe, undefined);
    assert.ok(f.heartbeats.every(heartbeat => heartbeat.capabilityDigests.length === 0));
  }
});
