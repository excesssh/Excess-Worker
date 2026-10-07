import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runWorker } from "../apps/worker/dist/runtime.js";
import { setWorkerControl } from "../apps/worker/dist/control.js";
import { WorkerConnectionError } from "../apps/worker/dist/identity.js";
import { MEDIA_CATALOG, toneWav } from "../packages/adapters/dist/index.js";
import { requestDigest, MEDIA_LIMITS } from "../packages/protocol/dist/index.js";
import { createFixtureScratch } from "./helpers/fixture-scratch.mjs";

// A fake coordinator and a fake media adapter exercise the buffered job path. Nothing here is model or hardware evidence.
const timings = { pollMs: 20, heartbeatMs: 20, renewMs: 20, monitorMs: 10 };
const ready = { freeMemoryMb: 8192, idleSeconds: 120 };
const PART = MEDIA_LIMITS.artifactPartBytes;
const sha = data => createHash("sha256").update(data).digest("hex");
const ref = (data, contentType) => ({ digest: sha(data), bytes: data.length, contentType });
const live = new Set();
afterEach(async () => {
  const fixtures = [...live]; live.clear();
  for (const f of fixtures) f.shutdown.abort();
  await Promise.allSettled(fixtures.map(f => setWorkerControl(f.dir, "stop")));
  await Promise.allSettled(fixtures.flatMap(f => [...f.operations]));
  for (const f of fixtures) await f.scratch.cleanup();
});
const waitFor = async (check, message = "condition") => {
  const until = Date.now() + 8000;
  while (!await check()) { if (Date.now() > until) throw Error("Timed out: " + message); await new Promise(r => setTimeout(r, 10)); }
};

async function fixture(modelId, request, { maxUnits, output }) {
  const scratch = await createFixtureScratch("worker-media-fixture-"), dir = scratch.path;
  const shutdown = new AbortController(), operations = new Set();
  live.add({ dir, shutdown, operations, scratch });
  const entry = MEDIA_CATALOG.find(item => item.id === modelId);
  const policy = { threads: 1, maxMemoryMb: 1024, runSeconds: 5, idleOnly: false, idleSeconds: 60, model: modelId, backend: entry.gpuOnly ? "cuda" : "cpu" };
  const deviceId = randomUUID();
  const a = { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), runDeadlineAt: new Date(Date.now() + 90000).toISOString(),
    offerId: randomUUID(), capabilityDigest: entry.capabilityDigest, requestDigest: requestDigest(request), maxUnits };
  const inputs = new Map(), uploads = new Map(), calls = [];
  const state = { assigned: true, tamperPart: null, failArtifact: null, loseResult: 0, results: [] };
  const connection = {
    deviceId,
    async heartbeat() { return { accepted: true }; },
    async command(type, data) {
      calls.push({ type, data: structuredClone(data) });
      if (type === "worker.poll") return { executionEnabled: state.assigned, assignments: state.assigned ? [a] : [] };
      if (type === "job.input") return { request, requestDigest: a.requestDigest, capabilityDigest: entry.capabilityDigest, deliveryMode: "buffered",
        artifacts: [...inputs].map(([digest, bytes]) => ({ digest, bytes: bytes.length, contentType: "audio/wav", parts: Math.ceil(bytes.length / PART) })) };
      if (type === "job.artifact.read") {
        const bytes = inputs.get(data.digest); let chunk = bytes.subarray(data.part * PART, (data.part + 1) * PART);
        if (state.tamperPart === data.part) { chunk = Buffer.from(chunk); chunk[0] ^= 1; }
        return { digest: data.digest, part: data.part, parts: Math.ceil(bytes.length / PART), data: chunk.toString("base64") };
      }
      if (type === "job.started" || type === "job.renew") return { state: "running", leaseExpiresAt: a.leaseExpiresAt };
      if (type === "job.artifact") {
        if (state.failArtifact && state.failArtifact.part === data.part) { const error = state.failArtifact.error; state.failArtifact = null; throw error; }
        assert.ok(data.data.length <= Math.ceil(PART / 3) * 4 && data.part < data.parts);
        if (!uploads.has(data.digest)) uploads.set(data.digest, new Map());
        uploads.get(data.digest).set(data.part, Buffer.from(data.data, "base64"));
        return { accepted: true, digest: data.digest, part: data.part };
      }
      if (type === "job.failed") { state.assigned = false; return { state: "failed" }; }
      if (type === "job.result") {
        state.results.push(structuredClone(data));
        assert.equal(data.outputDigest, requestDigest(data.output));
        for (const artifact of data.output.kind === "embedding" ? [data.output.vectors] : data.output.kind === "image" ? data.output.images : []) {
          const parts = uploads.get(artifact.digest);
          assert.ok(parts, "every artifact is uploaded before the result");
          assert.equal(sha(Buffer.concat([...parts.keys()].sort((x, y) => x - y).map(part => parts.get(part)))), artifact.digest);
        }
        if (state.loseResult > 0) { state.loseResult--; throw new WorkerConnectionError(null); }
        state.assigned = false; return { accepted: true, state: "verifying" };
      }
      throw Error("Unknown test command " + type);
    },
  };
  const counts = { executions: 0, probes: 0 }, received = [];
  const adapter = {
    kind: entry.kind, check: value => value,
    async probe() {
      counts.probes++;
      // Synthetic observation for schema tests only; not hardware evidence.
      return { ok: true, kind: entry.kind, capabilityDigest: entry.capabilityDigest, backend: policy.backend, modelId, model: entry.capability.model, runtime: entry.capability.runtime,
        threads: 1, maxMemoryMb: 1024, probedAt: new Date().toISOString(), generatedTokens: 0, peakRssMb: 64, nativePid: 700001, guardianPid: 700002 };
    },
    async execute(value, options) { counts.executions++; received.push({ value, inputs: options.inputs }); return output; },
    async stop() {},
  };
  const start = () => {
    const operation = (async () => {
      await setWorkerControl(dir, "run");
      return runWorker({ identityPath: join(dir, "unused-identity.json"), stateDir: dir, installDir: join(dir, "NO_MODEL_INSTALLED"), policy, timings, connection, adapter,
        telemetry: async () => ready, offer: null, signal: shutdown.signal });
    })();
    operations.add(operation); operation.then(() => operations.delete(operation), () => operations.delete(operation));
    return operation;
  };
  const journal = async () => { try { return (await readFile(join(dir, "attempts.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  const stop = async running => { await setWorkerControl(dir, "stop"); return running; };
  return { dir, a, state, inputs, uploads, calls, counts, received, start, journal, stop, scratch };
}
const imageOutput = () => {
  const first = Buffer.alloc(600000, 1), second = Buffer.alloc(300000, 2);
  const r1 = ref(first, "image/png"), r2 = ref(second, "image/png");
  return { request: { kind: "image", prompt: "TEST FIXTURE PROMPT", width: 512, height: 512, steps: 1, count: 2, seed: 1 },
    output: { result: { kind: "image", width: 512, height: 512, images: [r1, r2] }, artifacts: [{ ref: r1, data: first }, { ref: r2, data: second }] }, parts: 3 + 2 };
};

test("transcription input downloads part by part, is digest-checked before start and bills whole audio seconds", async () => {
  const wav = toneWav(10000), audio = ref(wav, "audio/wav");
  const request = { kind: "transcription", audio, durationMs: 10000 };
  const output = { result: { kind: "transcription", text: "TEST FIXTURE TRANSCRIPT", audioSeconds: 10 }, artifacts: [] };
  const f = await fixture("qwen3-asr-0.6b", request, { maxUnits: "10", output });
  f.inputs.set(audio.digest, wav);
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "finished", "result receipted");
  await f.stop(running);
  const types = f.calls.map(call => call.type);
  assert.deepEqual(f.calls.filter(call => call.type === "job.artifact.read").map(call => call.data.part), [0, 1]);
  assert.ok(types.lastIndexOf("job.artifact.read") < types.indexOf("job.started"), "the input is complete before the job starts");
  assert.ok(f.received[0].inputs.get(audio.digest).equals(wav));
  assert.deepEqual([f.state.results[0].reportedUnits, f.state.results[0].output], ["10", output.result]);
  assert.deepEqual((await f.journal()).map(item => item.state), ["seen", "running", "result_pending", "finished"]);
});

test("image outputs upload in bounded parts before the result, and journaled artifact files are removed after the receipt", async () => {
  const { request, output, parts } = imageOutput();
  const f = await fixture("sd-turbo", request, { maxUnits: "2", output });
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "finished", "result receipted");
  await f.stop(running);
  const types = f.calls.map(call => call.type);
  assert.equal(types.filter(type => type === "job.artifact").length, parts);
  assert.ok(types.lastIndexOf("job.artifact") < types.indexOf("job.result"));
  assert.equal(f.state.results[0].reportedUnits, "2");
  for (const artifact of output.artifacts) assert.ok(Buffer.concat([...f.uploads.get(artifact.ref.digest).values()]).equals(artifact.data));
  assert.deepEqual((await readdir(f.dir)).filter(name => name.includes(".artifact.") || name.endsWith(".result.json")), []);
});

test("embedding token reports are bounded by the quote", async () => {
  const vectors = Buffer.alloc(2 * 1024 * 4, 3), vectorsRef = ref(vectors, "application/vnd.excess.float32le");
  const request = { kind: "embedding", inputs: ["a", "b"] };
  const output = { result: { kind: "embedding", dimensions: 1024, count: 2, inputTokens: 5, vectors: vectorsRef }, artifacts: [{ ref: vectorsRef, data: vectors }] };
  const f = await fixture("qwen3-embedding-0.6b", request, { maxUnits: "2", output });
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "finished", "result receipted");
  await f.stop(running);
  assert.deepEqual([f.state.results[0].reportedUnits, f.state.results[0].output.inputTokens], ["2", 2]);
});

test("a tampered input part or a quote mismatch never starts execution", async () => {
  const wav = toneWav(10000), audio = ref(wav, "audio/wav"), request = { kind: "transcription", audio, durationMs: 10000 };
  const output = { result: { kind: "transcription", text: "unused", audioSeconds: 10 }, artifacts: [] };
  const tampered = await fixture("qwen3-asr-0.6b", request, { maxUnits: "10", output });
  tampered.inputs.set(audio.digest, wav); tampered.state.tamperPart = 1;
  let running = tampered.start();
  await waitFor(() => tampered.calls.some(call => call.type === "job.failed"), "failure reported");
  await tampered.stop(running);
  assert.deepEqual([tampered.counts.executions, tampered.calls.some(call => call.type === "job.started")], [0, false]);
  assert.equal(tampered.calls.find(call => call.type === "job.failed").data.reason, "cancelled_locally");
  assert.equal((await tampered.journal()).at(-1).state, "abandoned");

  const { request: imageRequest, output: imageResult } = imageOutput();
  const underquoted = await fixture("sd-turbo", imageRequest, { maxUnits: "3", output: imageResult });
  running = underquoted.start();
  await waitFor(() => underquoted.calls.some(call => call.type === "job.failed"), "failure reported");
  await underquoted.stop(running);
  assert.deepEqual([underquoted.counts.executions, underquoted.calls.some(call => call.type === "job.started")], [0, false]);
});

test("losing the lease mid-upload abandons the attempt without a result", async () => {
  const { request, output } = imageOutput();
  const f = await fixture("sd-turbo", request, { maxUnits: "2", output });
  f.state.failArtifact = { part: 1, error: new WorkerConnectionError(409, "LEASE_NOT_LIVE") };
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "abandoned", "attempt abandoned");
  await f.stop(running);
  const last = (await f.journal()).at(-1);
  assert.deepEqual([last.reason, f.counts.executions, f.state.results.length], ["result_no_longer_accepted", 1, 0]);
  assert.deepEqual((await readdir(f.dir)).filter(name => name.includes(".artifact.")), []);
});

test("a lost result receipt resends every artifact part idempotently and never executes again", async () => {
  const { request, output, parts } = imageOutput();
  const f = await fixture("sd-turbo", request, { maxUnits: "2", output });
  f.state.loseResult = 1;
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "finished", "result receipted");
  await f.stop(running);
  assert.equal(f.counts.executions, 1);
  assert.equal(f.state.results.length, 2);
  assert.equal(f.calls.filter(call => call.type === "job.artifact").length, 2 * parts);
});

test("a pending media upload survives a restart and is resent without executing", async () => {
  const { request, output, parts } = imageOutput();
  const f = await fixture("sd-turbo", request, { maxUnits: "2", output });
  f.state.assigned = false;
  const lines = ["seen", "running", "result_pending"].map(state => JSON.stringify({ assignment: f.a, state, reason: "TEST FIXTURE", updatedAt: new Date().toISOString(),
    ...(state === "result_pending" ? { resultDigest: requestDigest(output.result) } : {}) }));
  await writeFile(join(f.dir, "attempts.jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
  await writeFile(join(f.dir, f.a.attemptId + ".result.json"), JSON.stringify(output.result), { mode: 0o600 });
  for (const artifact of output.artifacts) await writeFile(join(f.dir, `${f.a.attemptId}.artifact.${artifact.ref.digest}.bin`), artifact.data, { mode: 0o600 });
  const running = f.start();
  await waitFor(async () => (await f.journal()).at(-1)?.state === "finished", "pending result receipted");
  await f.stop(running);
  assert.deepEqual([f.counts.executions, f.state.results.length, f.calls.filter(call => call.type === "job.artifact").length], [0, 1, parts]);
});
