import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { setWorkerControl } from "../apps/worker/dist/control.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { capabilityDigest, TEXT_CAPABILITY } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";
import { createFixtureScratch } from "./helpers/fixture-scratch.mjs";

// Synthetic executor and receipts. Blocking the test event loop deliberately
// delays JS timers; no model, native process or hardware claim is involved.
const live = new Set();
afterEach(async () => {
  const fixtures = [...live]; live.clear();
  for (const f of fixtures) f.shutdown.abort();
  await Promise.allSettled(fixtures.flatMap(f => [...f.operations]));
  for (const f of fixtures) await f.scratch.cleanup();
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => {
  const until = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > until) throw Error("Synthetic deadline fixture timed out"); await pause(10); }
};
async function fixture(deliveryMode, late = true) {
  const scratch = await createFixtureScratch("worker-deadline-fixture-"), dir = scratch.path;
  const shutdown = new AbortController(), operations = new Set(); live.add({ shutdown, operations, scratch });
  const request = { prompt: "SYNTHETIC DEADLINE INPUT", maxTokens: 1, seed: 42 };
  const output = { text: "FIXTURE", generatedTokens: 1, finishReason: "stop" };
  const chunk = { sequence: 1, delta: output.text, tokenIds: [1] }; chunk.chunkDigest = requestDigest(chunk);
  const deviceId = randomUUID(), calls = [];
  const a = { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1", offerId: randomUUID(), capabilityDigest,
    requestDigest: requestDigest(request), maxUnits: "1", leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), runDeadlineAt: new Date(Date.now() + 90000).toISOString() };
  const state = { assigned: true, executions: 0, resultBlocked: false };
  const connection = { deviceId,
    async heartbeat() { return { accepted: true }; },
    async command(type, data) {
      calls.push({ type, data: structuredClone(data) });
      if (type === "worker.poll") return { executionEnabled: state.assigned, assignments: state.assigned ? [a] : [] };
      if (type === "job.input") return { request, requestDigest: a.requestDigest, capabilityDigest, deliveryMode };
      if (type === "job.started" || type === "job.renew") return { state: "running", leaseExpiresAt: a.leaseExpiresAt };
      if (type === "job.failed") { state.assigned = false; return { state: "failed" }; }
      if (type === "job.chunk") return { accepted: true, sequence: data.sequence, chunkDigest: data.chunkDigest };
      if (type === "job.result") {
        state.assigned = false;
        if (state.resultBlocked) throw new WorkerConnectionError(null);
        return { accepted: true, state: "verifying" };
      }
      throw Error("Unexpected synthetic command");
    },
  };
  const adapter = { supportsStreaming: true,
    async probe() { return { ok: true, capabilityDigest, backend: "cpu", model: TEXT_CAPABILITY.model, runtime: TEXT_CAPABILITY.runtime,
      threads: 1, maxMemoryMb: 1024, probedAt: new Date().toISOString(), generatedTokens: 1, peakRssMb: 1 }; },
    async execute(_request, { onChunk }) {
      state.executions++;
      if (late) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1150);
      if (deliveryMode === "stream") await onChunk(chunk);
      return output;
    }, async stop() {},
  };
  const start = () => {
    const operation = (async () => {
      await setWorkerControl(dir, "run");
      return runWorker({ identityPath: join(dir, "unused.json"), stateDir: dir, installDir: join(dir, "NO_MODEL_INSTALLED"), adapter, connection,
        policy: { threads: 1, maxMemoryMb: 1024, runSeconds: 1, idleOnly: false, idleSeconds: 60 },
        telemetry: async () => ({ freeMemoryMb: 8192, idleSeconds: 120 }), signal: shutdown.signal,
        timings: { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 } });
    })();
    operations.add(operation); operation.then(() => operations.delete(operation), () => operations.delete(operation)); return operation;
  };
  const journal = async () => (await readFile(join(dir, "attempts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { dir, a, calls, state, start, journal, scratch };
}

for (const deliveryMode of ["buffered", "stream"]) test(`synthetic ${deliveryMode} output cannot publish past a local deadline when timers are delayed`, async () => {
  const f = await fixture(deliveryMode), running = f.start();
  await waitFor(() => f.calls.some(call => call.type === "job.failed"));
  await setWorkerControl(f.dir, "stop"); await running;
  assert.ok(Date.parse(f.a.leaseExpiresAt) > Date.now(), "the coordinator lease is still live");
  assert.equal(f.state.executions, 1); assert.equal(f.calls.filter(call => call.type === "job.chunk").length, 0);
  assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
  assert.equal((await f.journal()).at(-1).state, "abandoned");
  assert.ok(!(await readdir(f.dir)).some(file => file.endsWith(".result.json")));
});

test("synthetic result completed within its deadline remains retryable after restart without a new execution timer", async () => {
  const f = await fixture("stream", false); f.state.resultBlocked = true;
  const first = f.start(); await waitFor(() => f.calls.some(call => call.type === "job.result"));
  await setWorkerControl(f.dir, "stop"); await first;
  assert.equal((await f.journal()).at(-1).state, "result_pending");
  await pause(1200); f.state.resultBlocked = false;
  const second = f.start(); await waitFor(async () => (await f.journal()).at(-1).state === "finished");
  await setWorkerControl(f.dir, "stop"); await second;
  assert.equal(f.state.executions, 1); assert.equal(f.calls.filter(call => call.type === "job.chunk").length, 1);
  const results = f.calls.filter(call => call.type === "job.result"); assert.ok(results.length >= 2);
  assert.deepEqual(results[0].data, results.at(-1).data);
});
