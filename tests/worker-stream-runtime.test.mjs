import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { setWorkerControl } from "../apps/worker/dist/control.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { capabilityDigest, TEXT_CAPABILITY } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";

// Injected adapters and coordinator receipts are synthetic transport fixtures.
// Nothing in this file starts a model or attests hardware/token observations.
const policy = { threads: 1, maxMemoryMb: 1024, runSeconds: 5, idleOnly: false, idleSeconds: 60 };
const timings = { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 };
const fixtures = new Set();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async (check, label = "condition") => {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw Error("Timed out: " + label); await new Promise(r => setTimeout(r, 10)); }
};
const wait = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener("abort", abort); reject(Error("SYNTHETIC EXECUTION ABORT")); };
  signal.addEventListener("abort", abort, { once: true });
  promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  if (signal.aborted) abort();
});
afterEach(async () => {
  const active = [...fixtures]; fixtures.clear();
  for (const f of active) f.shutdown.abort();
  await Promise.allSettled(active.map(f => setWorkerControl(f.dir, "stop")));
  await Promise.allSettled(active.flatMap(f => [...f.operations]));
});

async function fixture() {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/worker-stream-fixture-"));
  const shutdown = new AbortController(), operations = new Set();
  fixtures.add({ dir, shutdown, operations });
  const request = { prompt: "SYNTHETIC STREAM REQUEST", maxTokens: 16, seed: 42 }, deviceId = randomUUID();
  const a = { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1", offerId: randomUUID(), capabilityDigest,
    requestDigest: requestDigest(request), maxUnits: "16", leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), runDeadlineAt: new Date(Date.now() + 90000).toISOString() };
  const chunks = [{ sequence: 1, delta: "SYNTHETIC STREAM ", tokenIds: [11, 12, 13, 14, 15, 16, 17, 18] },
    { sequence: 2, delta: "OUTPUT", tokenIds: [19, 20] }].map(value => ({ ...value, chunkDigest: requestDigest(value) }));
  const output = { text: chunks.map(chunk => chunk.delta).join(""), generatedTokens: 10, finishReason: "stop" };
  const calls = [], heartbeats = [], acceptedChunks = [];
  const state = { assigned: true, ignoreFailure: false, deliveryMode: "stream", ackGate: null, executionGate: null, loseChunkAck: false,
    wrongChunkAck: false, loseResultAck: false, resultBlocked: false, corruptChunk: null, ignoreCallback: false, wrongOutput: false,
    executions: 0, callbacksCompleted: 0, stopped: 0, aborted: 0 };
  const connection = {
    deviceId,
    async heartbeat(value) { heartbeats.push(structuredClone(value)); return { accepted: true }; },
    async command(type, data, signal) {
      calls.push({ type, data: structuredClone(data) });
      if (type === "worker.poll") return { executionEnabled: state.assigned, assignments: state.assigned ? [a] : [] };
      if (type === "job.input") return { request, requestDigest: a.requestDigest, capabilityDigest, deliveryMode: state.deliveryMode };
      if (type === "job.started" || type === "job.renew") return { state: "running", leaseExpiresAt: a.leaseExpiresAt };
      if (type === "job.chunk") {
        acceptedChunks.push(structuredClone(data));
        if (state.ackGate) await wait(state.ackGate.promise, signal);
        if (state.loseChunkAck) { state.loseChunkAck = false; throw new WorkerConnectionError(null); }
        return { accepted: true, sequence: state.wrongChunkAck ? data.sequence + 1 : data.sequence, chunkDigest: data.chunkDigest };
      }
      if (type === "job.failed") { if (!state.ignoreFailure) state.assigned = false; return { state: "failed" }; }
      if (type === "job.result") {
        assert.equal(data.outputDigest, requestDigest(data.output)); assert.equal(data.reportedUnits, String(data.output.generatedTokens));
        state.assigned = false;
        if (state.resultBlocked || state.loseResultAck) { state.loseResultAck = false; throw new WorkerConnectionError(null); }
        return { accepted: true, state: "verifying" };
      }
      throw Error("Unexpected synthetic command " + type);
    },
  };
  const adapter = {
    supportsStreaming: true,
    async probe() { return { ok: true, capabilityDigest, backend: "cpu", model: TEXT_CAPABILITY.model, runtime: TEXT_CAPABILITY.runtime,
      threads: policy.threads, maxMemoryMb: policy.maxMemoryMb, probedAt: new Date().toISOString(), generatedTokens: 1, peakRssMb: 10 }; },
    async execute(value, { signal, onChunk }) {
      state.executions++; assert.deepEqual(value, request);
      const abort = () => { state.aborted++; }; signal.addEventListener("abort", abort, { once: true });
      try {
        if (!state.ignoreCallback && state.deliveryMode === "stream") {
          assert.equal(typeof onChunk, "function");
          for (const original of chunks) {
            const chunk = structuredClone(original);
            if (state.corruptChunk) state.corruptChunk(chunk);
            await onChunk(chunk); state.callbacksCompleted++;
            if (state.executionGate) await wait(state.executionGate.promise, signal);
          }
        } else assert.equal(typeof onChunk, state.deliveryMode === "stream" ? "function" : "undefined");
        signal.throwIfAborted();
        return state.wrongOutput ? { ...output, text: "UNACKNOWLEDGED OUTPUT" } : output;
      } finally { signal.removeEventListener("abort", abort); }
    },
    async stop() { state.stopped++; },
  };
  const start = (extra = {}) => {
    const operation = (async () => {
      await setWorkerControl(dir, "run");
      return runWorker({ identityPath: join(dir, "unused.json"), stateDir: dir, installDir: join(dir, "NO_MODEL_INSTALLED"),
        policy, timings, adapter, connection, telemetry: async () => ({ freeMemoryMb: 8192, idleSeconds: 120 }), ...extra,
        signal: extra.signal ? AbortSignal.any([shutdown.signal, extra.signal]) : shutdown.signal });
    })();
    operations.add(operation); operation.then(() => operations.delete(operation), () => operations.delete(operation)); return operation;
  };
  const journal = async () => (await readFile(join(dir, "attempts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { dir, a, chunks, output, state, calls, heartbeats, acceptedChunks, adapter, start, journal };
}

test("synthetic worker stream persists ordered chunks with backpressure, renews while awaiting ack, and drains", async () => {
  const f = await fixture(); f.state.ackGate = deferred();
  const running = f.start();
  await waitFor(() => f.acceptedChunks.length === 1, "first synthetic chunk");
  await waitFor(() => f.calls.some(call => call.type === "job.renew"), "renewal during backpressure");
  assert.equal(f.state.callbacksCompleted, 0); assert.equal(f.acceptedChunks.length, 1);
  await setWorkerControl(f.dir, "drain");
  await new Promise(r => setTimeout(r, 50));
  f.state.ackGate.resolve();
  assert.equal((await running).reason, "drained");
  assert.equal(f.state.executions, 1); assert.equal(f.state.callbacksCompleted, 2);
  assert.deepEqual(f.acceptedChunks.map(({ jobId, attemptId, fence, ...value }) => {
    assert.equal(jobId, f.a.jobId); assert.equal(attemptId, f.a.attemptId); assert.equal(fence, f.a.fence); return value;
  }), f.chunks);
  assert.deepEqual(f.calls.find(call => call.type === "job.result").data.output, f.output);
  assert.equal((await f.journal()).at(-1).state, "finished");
  assert.ok(!(await readdir(f.dir)).some(file => file.endsWith(".result.json")));
  assert.equal(f.heartbeats.at(-1).availableSlots, 0);
});

test("synthetic worker stop cancels an interrupted stream and restart never re-executes the attempt", async () => {
  const f = await fixture(); f.state.executionGate = deferred(); f.state.ignoreFailure = true;
  const first = f.start();
  await waitFor(() => f.state.callbacksCompleted === 1);
  await setWorkerControl(f.dir, "stop"); await first;
  assert.equal(f.state.aborted, 1); assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
  assert.equal((await f.journal()).at(-1).state, "abandoned");
  const priorFailures = f.calls.filter(call => call.type === "job.failed").length;
  const second = f.start();
  await waitFor(() => f.calls.filter(call => call.type === "job.failed").length > priorFailures);
  await setWorkerControl(f.dir, "stop"); await second;
  assert.equal(f.state.executions, 1); assert.equal(f.acceptedChunks.length, 1);
  assert.equal(f.heartbeats.at(-1).availableSlots, 0);
});

test("synthetic worker lost chunk acknowledgement aborts without replay or final result", async () => {
  const f = await fixture(); f.state.loseChunkAck = true; f.state.ignoreFailure = true;
  const first = f.start();
  await waitFor(() => f.calls.some(call => call.type === "job.failed"));
  await setWorkerControl(f.dir, "stop"); await first;
  assert.equal(f.state.aborted, 1); assert.equal(f.state.callbacksCompleted, 0);
  assert.equal(f.acceptedChunks.length, 1); assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
  const second = f.start(); await waitFor(() => f.calls.filter(call => call.type === "worker.poll").length >= 2);
  await setWorkerControl(f.dir, "stop"); await second;
  assert.equal(f.state.executions, 1); assert.equal(f.acceptedChunks.length, 1);
});

test("synthetic worker refuses unsupported streaming and silent buffered fallback", async () => {
  for (const unsupported of [true, false]) {
    const f = await fixture();
    if (unsupported) delete f.adapter.supportsStreaming; else f.state.ignoreCallback = true;
    const running = f.start();
    await waitFor(() => f.calls.some(call => call.type === "job.failed"));
    await setWorkerControl(f.dir, "stop"); await running;
    assert.equal(f.state.executions, unsupported ? 0 : 1);
    assert.equal(f.calls.filter(call => call.type === "job.started").length, unsupported ? 0 : 1);
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
  }
});

test("synthetic worker rejects invalid chunk identities, bounds, acknowledgement and final stream mismatch", async () => {
  const mutations = [
    state => { state.corruptChunk = chunk => { chunk.sequence = 2; }; },
    state => { state.corruptChunk = chunk => { chunk.chunkDigest = "0".repeat(64); }; },
    state => { state.corruptChunk = chunk => { chunk.tokenIds = Array.from({ length: 17 }, (_, i) => i); chunk.chunkDigest = requestDigest({ sequence: chunk.sequence, delta: chunk.delta, tokenIds: chunk.tokenIds }); }; },
    state => { state.wrongChunkAck = true; }, state => { state.wrongOutput = true; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); mutate(f.state);
    const running = f.start();
    await waitFor(() => f.calls.some(call => call.type === "job.failed"));
    await setWorkerControl(f.dir, "stop"); await running;
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
    assert.equal((await f.journal()).at(-1).state, "abandoned");
  }
});

test("synthetic worker retries a durable completed stream result after restart without replaying chunks", async () => {
  const f = await fixture(); f.state.resultBlocked = true;
  const first = f.start();
  await waitFor(() => f.calls.some(call => call.type === "job.result"));
  await setWorkerControl(f.dir, "stop"); await first;
  assert.equal((await f.journal()).at(-1).state, "result_pending");
  f.state.resultBlocked = false;
  const second = f.start();
  await waitFor(async () => (await f.journal()).at(-1).state === "finished");
  await setWorkerControl(f.dir, "stop"); await second;
  assert.equal(f.state.executions, 1); assert.equal(f.acceptedChunks.length, 2);
  const receipts = f.calls.filter(call => call.type === "job.result");
  assert.ok(receipts.length >= 2); assert.deepEqual(receipts.at(-1).data, receipts[0].data);
  assert.ok(!(await readdir(f.dir)).some(file => file.endsWith(".result.json")));
});

test("synthetic worker keeps the buffered delivery path without chunk callbacks", async () => {
  const f = await fixture(); f.state.deliveryMode = "buffered"; delete f.adapter.supportsStreaming;
  const running = f.start(); await waitFor(() => f.calls.some(call => call.type === "job.result"));
  await setWorkerControl(f.dir, "stop"); await running;
  assert.equal(f.state.executions, 1); assert.equal(f.acceptedChunks.length, 0);
  assert.equal((await f.journal()).at(-1).state, "finished");
});
