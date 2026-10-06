import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, access, unlink, readdir, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runWorker, unpairDevice } from "../apps/worker/dist/runtime.js";
import { setWorkerControl, readWorkerControl, readWorkerStatus, acquireRuntimeLock } from "../apps/worker/dist/control.js";
import { parseWorkerPolicy, policyDecision, readWorkerPolicy, writeWorkerPolicy } from "../apps/worker/dist/policy.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { removeWorkerOffer, writeWorkerOffer } from "../apps/worker/dist/offer.js";
import { capabilityDigest, TEXT_CAPABILITY } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";
import { createControllerStateStore } from "../apps/worker/dist/controller-state.js";
import { createWindowsExecutionProofStore } from "../apps/worker/dist/windows-execution-proof-store.js";

const policy = { threads: 1, maxMemoryMb: 1024, runSeconds: 2, idleOnly: false, idleSeconds: 60, model: "qwen3-4b", backend: "cpu", schedule: [], pauseOnBattery: true, autoUpdate: false, maxCpuTempC: 95, maxGpuTempC: 85 };
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
  // Idle-only is the default on Windows desktops; a Linux supplier is usually a headless server with no idle signal.
  assert.equal(parseWorkerPolicy({}).idleOnly, process.platform === "win32");
  // A refused policy names the setting, since the worker keeps its previous policy (GPU session 2: runSeconds 900).
  for (const [input, message] of [[{ runSeconds: 900 }, /Invalid worker policy: runSeconds must be a whole number from 1 to 600/],
    [{ maxMemoryMb: 512 }, /maxMemoryMb must be a whole number from 1024 to 262144/], [{ extra: 1 }, /unknown setting extra/],
    [null, /expected a JSON object/], [{ model: "flux1-schnell", backend: "cpu" }, /flux1-schnell runs on a GPU only/], [{ model: "nope" }, /model must be a catalog model id/]])
    assert.throws(() => parseWorkerPolicy(input), message);
  assert.equal(parseWorkerPolicy({}).runSeconds, 600, "the default allows a normal 2,048-token CPU job");
  assert.equal(parseWorkerPolicy({ runSeconds: 600 }).runSeconds, 600);
  for (const value of [{ threads: 0 }, { threads: 65 }, { maxMemoryMb: 512 }, { maxMemoryMb: 262145 }, { model: "not-in-catalog" }, { backend: "rocm" }, { runSeconds: 0 }, { runSeconds: 601 }, { idleOnly: "false" }, { gpu: true }]) assert.throws(() => parseWorkerPolicy(value));
  assert.equal(policyDecision({ ...policy, idleOnly: true }, { ...ready, idleSeconds: null }).reason, "idle_observation_unavailable");
  assert.equal(policyDecision(policy, { ...ready, freeMemoryMb: null }).allowed, false);
  assert.equal(policyDecision(policy, { ...ready, freeMemoryMb: 100 }).allowed, false);
  // The loaded runtime's own memory counts toward the allowance (the 8 GB Debian droplet, 19 September 2026: Qwen3-4B
  // held 3,632 MB after its probe and the machine reported 3,770 MB free, so a 6,144 MB policy refused every job).
  const warm = { ...policy, maxMemoryMb: 6144 }, afterProbe = { ...ready, freeMemoryMb: 3770 };
  assert.equal(policyDecision(warm, afterProbe).reason, "memory_headroom");
  assert.equal(policyDecision(warm, afterProbe, false, 3632).allowed, true);
  assert.match(policyDecision(warm, { ...ready, freeMemoryMb: 2000 }, false, 3632).detail, /needs 2640 MB free \(maxMemoryMb 6144 plus 128 MB, less 3632 MB the loaded model already holds\)/);
  assert.equal(policyDecision(warm, { ...ready, freeMemoryMb: 127 }, false, 99999).allowed, false, "the credit never exceeds the policy's own allowance");
  assert.equal(policyDecision(warm, { ...ready, freeMemoryMb: 128 }, false, 99999).allowed, true);
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

test("synthetic controller worker delegates durable state and preserves the outside host lock", async () => {
  const f = await fixture();
  await chmod(f.dir, 0o700);
  const hostLock = await acquireRuntimeLock(f.dir);
  const ownerBefore = await readFile(join(f.dir, "runtime.lock"), "utf8");
  const store = await createControllerStateStore({ stateDir: f.dir, markShutdownUnverified: () => hostLock.markShutdownUnverified() });
  const operations = [], cancel = new AbortController();
  const stateWriter = {
    async replace(name, bytes) { operations.push({ op: "replace", name }); await store.replace(name, bytes); },
    async appendJournal(bytes) { operations.push({ op: "append" }); await store.appendJournal(bytes); },
    async removeOutput(name) { operations.push({ op: "remove", name }); await store.removeOutput(name); },
    async markShutdownUnverified() { operations.push({ op: "mark" }); await store.markShutdownUnverified(); },
  };
  let running;
  try {
    running = f.start({ stateWriter, signal: cancel.signal });
    await waitFor(() => f.counts.executions === 1);
    await setWorkerControl(f.dir, "drain"); // trusted host operation
    f.complete(output);
    assert.equal((await running).reason, "drained");
    await store.drain();
    assert.deepEqual((await f.journal()).map(entry => entry.state), ["seen", "running", "result_pending", "finished"]);
    assert.ok(operations.some(op => op.op === "replace" && op.name === "status.json"));
    assert.ok(operations.some(op => op.op === "replace" && op.name === "journal-owner.json"));
    assert.ok(operations.some(op => op.op === "replace" && op.name === f.a.attemptId + ".result.json"));
    assert.equal(operations.filter(op => op.op === "append").length, 4);
    assert.ok(operations.some(op => op.op === "remove" && op.name === f.a.attemptId + ".result.json"));
    assert.equal(operations.some(op => op.op === "mark"), false);
    assert.equal(await readFile(join(f.dir, "runtime.lock"), "utf8"), ownerBefore, "controller exit cannot release or replace its host-owned lock");
    await assert.rejects(acquireRuntimeLock(f.dir), /already running/);
    assert.equal((await readWorkerStatus(f.dir)).state, "stopped");
  } finally {
    cancel.abort();
    await running?.catch(() => undefined);
    await store.close();
    await hostLock();
  }
  await assert.rejects(access(join(f.dir, "runtime.lock")), { code: "ENOENT" });
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

test("unpair retires the identity and journal for a new pairing, never while the worker runs or a result waits", async () => {
  // The failover rehearsal re-paired a machine to another wallet: pair refused the old identity, and after moving it by
  // hand the worker stopped with "Attempt journal belongs to another device".
  const f = await fixture();
  await writeFile(join(f.dir, "identity.json"), JSON.stringify({ version: 1, origin: "https://exchange.test", deviceId: f.a.deviceId }), { mode: 0o600 });
  await writeFile(join(f.dir, "journal-owner.json"), JSON.stringify({ version: 1, deviceId: f.a.deviceId }), { mode: 0o600 });
  const line = state => JSON.stringify({ assignment: f.a, state, reason: "TEST FIXTURE", updatedAt: new Date().toISOString(),
    ...(state === "result_pending" ? { resultDigest: requestDigest(output) } : {}) }) + "\n";
  await writeFile(join(f.dir, "attempts.jsonl"), ["seen", "running", "result_pending"].map(line).join(""), { mode: 0o600 });
  await writeFile(join(f.dir, f.a.attemptId + ".result.json"), JSON.stringify(output), { mode: 0o600 });
  await assert.rejects(unpairDevice(f.dir), /1 finished job result still waits for the exchange/);
  await writeFile(join(f.dir, "attempts.jsonl"), line("finished"), { flag: "a" });
  const store = await createWindowsExecutionProofStore(f.dir);
  const proof = { assignment: f.a, inputDigest: 'c'.repeat(64), output, outputDigest: requestDigest(output),
    completedAt: new Date().toISOString() };
  await store.save(proof);
  await assert.rejects(unpairDevice(f.dir), /CONTROLLER_EXECUTION_RECEIPT_PENDING/);
  assert.equal((await store.load()).receiptAccepted, undefined);
  await access(join(f.dir, 'identity.json'));
  await store.save({ ...proof, receiptAccepted: true }); await store.close();
  const lock = await acquireRuntimeLock(f.dir);
  await assert.rejects(unpairDevice(f.dir), /already running/);
  await lock();
  const retired = await unpairDevice(f.dir);
  assert.deepEqual([retired.deviceId, retired.origin], [f.a.deviceId, "https://exchange.test"]);
  assert.deepEqual((await readdir(retired.retired)).sort(), [f.a.attemptId + ".result.json", "attempts.jsonl", "identity.json", "journal-owner.json", "host-execution-proof"].sort());
  assert.equal(JSON.parse(await readFile(join(retired.retired, 'host-execution-proof/proof.json'), 'utf8')).proof.receiptAccepted, true);
  await assert.rejects(access(join(f.dir, 'host-execution-proof')), { code: 'ENOENT' });
  for (const name of ["identity.json", "attempts.jsonl", "journal-owner.json"]) await assert.rejects(access(join(f.dir, name)), { code: "ENOENT" });
  assert.equal((await unpairDevice(f.dir)).retired, null, "nothing left to unpair");
});

test('unpair refuses a proof for another device without moving either identity or recovery evidence', async () => {
  const f = await fixture();
  await writeFile(join(f.dir, 'identity.json'), JSON.stringify({ deviceId: randomUUID(), origin: 'https://exchange.test' }), { mode: 0o600 });
  const store = await createWindowsExecutionProofStore(f.dir);
  await store.save({ assignment: f.a, inputDigest: 'c'.repeat(64), output, outputDigest: requestDigest(output),
    completedAt: new Date().toISOString(), receiptAccepted: true }); await store.close();
  await assert.rejects(unpairDevice(f.dir), /CONTROLLER_EXECUTION_DEVICE_MISMATCH/);
  await access(join(f.dir, 'identity.json')); await access(join(f.dir, 'host-execution-proof/proof.json'));
  await assert.rejects(access(join(f.dir, 'retired')), { code: 'ENOENT' });
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

test("fixture worker takes no work while too hot, finishes a job that warms past the limit, and stops one that overheats", async () => {
  const hot = await fixture(); hot.state.assigned = false;
  const waiting = hot.start({ telemetry: async () => ({ ...ready, cpuTempC: 96 }) });
  await waitFor(() => hot.heartbeats.length >= 3);
  await waitFor(async () => (await readWorkerStatus(hot.dir)).reason === "too_hot");
  assert.match((await readWorkerStatus(hot.dir)).detail, /^CPU at 96 C; new jobs wait until it is below 95 C \(maxCpuTempC\)$/);
  await setWorkerControl(hot.dir, "stop"); await waiting;
  assert.equal(hot.counts.probes, 0); assert.equal(hot.counts.executions, 0);
  assert.ok(hot.heartbeats.every(h => h.availableSlots === 0), "a hot worker advertises no free slot");
  const f = await fixture(); let cpuTempC = 70;
  const running = f.start({ telemetry: async () => ({ ...ready, cpuTempC }) });
  await waitFor(() => f.counts.executions === 1);
  cpuTempC = 97;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.counts.aborts, 0, "between the limit and the margin the running job continues");
  cpuTempC = 100;
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

test("fixture worker applies price changes made while it runs and stops renewing an asset switched off", async () => {
  // The failover rehearsal found prices were read once at start, although `offer ... off` promised the worker would stop
  // renewing that offer.
  const f = await fixture(); f.state.assigned = false;
  const first = randomUUID(), second = randomUUID(), published = [];
  f.connection.offer = async data => { published.push(structuredClone(data)); return { published: true, offerId: randomUUID() }; };
  await writeWorkerOffer(f.dir, { assetId: first, netUnits: "5" }, policy.model);
  const running = f.start();
  await waitFor(() => published.some(o => o.assetId === first && o.netUnits === "5"), "the starting price is published");
  await writeWorkerOffer(f.dir, { assetId: first, netUnits: "4.5" }, policy.model);
  await writeWorkerOffer(f.dir, { assetId: second, netUnits: "900" }, policy.model);
  await waitFor(() => published.some(o => o.assetId === first && o.netUnits === "4.5") && published.some(o => o.assetId === second && o.netUnits === "900"),
    "a changed price and a new asset are published without a restart");
  await removeWorkerOffer(f.dir, first, policy.model);
  const mark = published.length;
  await waitFor(() => published.slice(mark).filter(o => o.assetId === second).length >= 3, "the remaining asset keeps renewing");
  // A publication already under way when the file changed may renew the removed asset once; after that, never again.
  const settled = mark + published.slice(mark).findIndex(o => o.assetId === second) + 1;
  assert.deepEqual(published.slice(settled).filter(o => o.assetId === first), []);
  await setWorkerControl(f.dir, "stop");
  assert.equal((await running).state, "stopped");
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

test("fixture worker reports a newer published version, installs it only when idle, and returns updated for its supervisor", async () => {
  const newer = { current: "0.1.0-aaaaaaaaaaaa", latest: "0.1.0-bbbbbbbbbbbb", available: true, checkedAt: new Date().toISOString() };
  // Report only: without auto-install the check is shown in status and nothing is installed.
  const quiet = await fixture(); quiet.state.assigned = false;
  let installs = 0;
  const reporting = quiet.start({ update: { origin: "https://exchange.example", current: newer.current, autoInstall: false, firstCheckMs: 10, intervalMs: 50,
    check: async () => newer, install: async () => { installs++; return 0; } } });
  await waitFor(async () => (await readWorkerStatus(quiet.dir)).update?.available === true, "update reported");
  await setWorkerControl(quiet.dir, "stop");
  assert.equal((await reporting).reason, "stopped_locally");
  assert.equal(installs, 0);

  // Auto-install waits for the running job to finish and its result to be accepted, then installs once.
  const busy = await fixture();
  let checks = 0;
  const running = busy.start({ update: { origin: "https://exchange.example", current: newer.current, autoInstall: true, firstCheckMs: 300, intervalMs: 50,
    check: async () => { checks++; return newer; }, install: async () => { installs++; return 0; } } });
  await waitFor(() => busy.counts.executions === 1, "job running");
  // The first check comes while the job runs; later checks keep finding it busy.
  await waitFor(() => checks >= 3, "update checks while busy");
  assert.equal(installs, 0, "never installs while a job runs");
  assert.equal(busy.counts.aborts, 0, "and never interrupts it");
  busy.complete(output);
  const result = await running;
  assert.equal(result.reason, "updated");
  assert.equal(installs, 1);
  assert.equal(busy.state.acceptedResult, true, "the job's result was delivered before updating");
  assert.equal(busy.heartbeats.at(-1).availableSlots, 0, "capacity is withdrawn while updating");
  assert.equal(await readWorkerControl(busy.dir), "run", "an update is not a stop: the restarted worker keeps serving");
});
