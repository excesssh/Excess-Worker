import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createWindowsAdapterHost, createWindowsMediaAdapterClient } from "../apps/worker/dist/windows-controller-adapter.js";
import { createWindowsTextExecutionHost, parseWindowsTextExecutionProof } from "../apps/worker/dist/windows-controller-execution.js";
import { toneWav, AdapterError } from "../packages/adapters/dist/index.js";
import { mediaRequestSchema, mediaResultUnits, requestDigest, MEDIA_LIMITS } from "../packages/protocol/dist/index.js";

// Trust-boundary fixtures. These are not model or hardware execution evidence.
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = (data, contentType) => ({ digest: sha(data), bytes: data.length, contentType });
const png = () => {
  const data = Buffer.alloc(300000);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(data);
  data.writeUInt32BE(512, 16); data.writeUInt32BE(512, 20);
  Buffer.from("0000000049454e44ae426082", "hex").copy(data, data.length - 12);
  return data;
};
const cases = () => {
  const vectors = Buffer.alloc(8192), image = png(), audio = toneWav(10000);
  vectors.writeFloatLE(0.5, 0); vectors.writeFloatLE(-0.25, 4096);
  return [
    { request: { kind: "embedding", inputs: ["fixture one", "fixture two"] }, maxUnits: "16",
      output: { result: { kind: "embedding", count: 2, dimensions: 1024, inputTokens: 8, vectors: ref(vectors, "application/vnd.excess.float32le") }, artifacts: [{ ref: ref(vectors, "application/vnd.excess.float32le"), data: vectors }] } },
    { request: { kind: "transcription", audio: ref(audio, "audio/wav"), durationMs: 10000 }, maxUnits: "10", audio,
      output: { result: { kind: "transcription", text: "Fixture transcript.", audioSeconds: 10 }, artifacts: [] } },
    { request: { kind: "image", prompt: "fixture circle", width: 512, height: 512, count: 1, steps: 1, seed: 42 }, maxUnits: "1",
      output: { result: { kind: "image", width: 512, height: 512, images: [ref(image, "image/png")] }, artifacts: [{ ref: ref(image, "image/png"), data: image }] } },
  ];
};
async function fixture(c, { saved = { value: null }, execute, resultResponse } = {}) {
  const calls = [], deviceId = randomUUID(), now = Date.now(), capabilityDigest = "a".repeat(64);
  const assignment = saved.value?.assignment ?? { jobId: randomUUID(), attemptId: randomUUID(), deviceId, fence: "1", offerId: randomUUID(),
    capabilityDigest, requestDigest: requestDigest(c.request), maxUnits: c.maxUnits, leaseExpiresAt: new Date(now + 60000).toISOString(), runDeadlineAt: new Date(now + 120000).toISOString() };
  let stops = 0;
  const adapter = { kind: c.request.kind, check: value => { const parsed = mediaRequestSchema.parse(value); assert.equal(parsed.kind, c.request.kind); return parsed; },
    residentMb: () => 64, stop: async () => { stops++; },
    probe: async () => ({ ok: true, kind: c.request.kind, capabilityDigest, backend: "cpu", model: "fixture", modelId: "fixture", runtime: "fixture", threads: 1, maxMemoryMb: 2048,
      probedAt: new Date().toISOString(), generatedTokens: 0, elapsedMs: 1, peakRssMb: 64 }),
    execute: execute ?? (async (value, options) => {
      assert.deepEqual(value, c.request);
      if (c.audio) assert.deepEqual(options.inputs.get(c.request.audio.digest), c.audio);
      return c.output;
    }) };
  const adapterHost = createWindowsAdapterHost(adapter, 120);
  const coordinator = { async close() {}, async handle(payload) {
    calls.push(structuredClone(payload));
    if (payload.action !== "command") return { ok: true, value: null };
    if (payload.type === "worker.poll") return { ok: true, value: { executionEnabled: true, assignments: [assignment] } };
    if (payload.type === "job.input") return { ok: true, value: { request: c.request, requestDigest: assignment.requestDigest, capabilityDigest, deliveryMode: "buffered",
      artifacts: c.audio ? [{ ...c.request.audio, parts: Math.ceil(c.audio.length / MEDIA_LIMITS.artifactPartBytes) }] : [] } };
    if (payload.type === "job.artifact.read") return { ok: true, value: { digest: c.request.audio.digest, part: payload.data.part, parts: Math.ceil(c.audio.length / MEDIA_LIMITS.artifactPartBytes),
      data: c.audio.subarray(payload.data.part * MEDIA_LIMITS.artifactPartBytes, (payload.data.part + 1) * MEDIA_LIMITS.artifactPartBytes).toString("base64") } };
    if (["job.started", "job.renew"].includes(payload.type)) return { ok: true, value: { state: "running", leaseExpiresAt: assignment.leaseExpiresAt } };
    if (payload.type === "job.result" && resultResponse) return resultResponse;
    return { ok: true, value: { accepted: true } };
  } };
  const proofStore = { load: async () => saved.value, save: async value => { saved.value = structuredClone(value); }, clear: async () => { saved.value = null; } };
  const host = await createWindowsTextExecutionHost({ coordinator, adapter: adapterHost, proofStore, deviceId: assignment.deviceId, capabilityDigest, media: adapter, runSeconds: 120 });
  const signal = new AbortController().signal;
  const command = (type, data = {}) => host.handleCoordinator({ action: "command", type, data }, signal);
  const client = createWindowsMediaAdapterClient((payload, abort) => host.handleAdapter(payload, abort ?? signal), c.request.kind);
  const attempt = { jobId: assignment.jobId, attemptId: assignment.attemptId, fence: assignment.fence };
  const start = async () => {
    await command("worker.poll"); await command("job.input", attempt);
    if (c.audio) for (let part = 0; part < Math.ceil(c.audio.length / MEDIA_LIMITS.artifactPartBytes); part++) await command("job.artifact.read", { ...attempt, digest: c.request.audio.digest, part });
    await command("job.started", attempt);
  };
  const result = output => ({ ...attempt, output, outputDigest: requestDigest(output), reportedUnits: String(mediaResultUnits(output)) });
  return { host, client, command, attempt, assignment, saved, calls, start, result, stops: () => stops };
}

for (const c of cases()) test(`${c.request.kind}: host binds input, output bytes, units and lost-receipt recovery`, async () => {
  const f = await fixture(c, { resultResponse: { ok: false, status: 503, code: "COORDINATOR_UNAVAILABLE" } });
  try {
    assert.equal((await f.client.probe()).kind, c.request.kind);
    await f.start();
    const output = await f.client.execute(c.request);
    assert.deepEqual(output, c.output);
    assert.deepEqual(parseWindowsTextExecutionProof(f.saved.value, f.assignment.deviceId, f.assignment.capabilityDigest, Date.now()).output, output.result);
    assert.equal(JSON.stringify(f.saved.value).includes(c.request.prompt ?? c.request.inputs?.[0] ?? "input_audio"), false);
    const completedProof = structuredClone(f.saved.value);
    await f.command("job.renew", f.attempt);
    assert.deepEqual(f.saved.value, completedProof, "delivery renewal preserves the observed output and completion lease");
    for (const artifact of output.artifacts) {
      const parts = Math.ceil(artifact.data.length / MEDIA_LIMITS.artifactPartBytes);
      const part = { ...f.attempt, ...artifact.ref, parts, part: 0, data: artifact.data.subarray(0, MEDIA_LIMITS.artifactPartBytes).toString("base64") };
      await assert.rejects(f.command("job.artifact", { ...part, data: Buffer.from("forged").toString("base64") }), /ARTIFACT_MISMATCH/);
      assert.equal(f.calls.filter(call => call.type === "job.artifact").length, 0);
      for (let i = 0; i < parts; i++) await f.command("job.artifact", { ...part, part: i, data: artifact.data.subarray(i * MEDIA_LIMITS.artifactPartBytes, (i + 1) * MEDIA_LIMITS.artifactPartBytes).toString("base64") });
    }
    await assert.rejects(f.command("job.result", { ...f.result(output.result), reportedUnits: "999" }), /RESULT_MISMATCH/);
    await f.command("job.result", f.result(output.result));
  } finally { await f.host.close(); }
  const next = await fixture(c, { saved: f.saved });
  try {
    await next.command("worker.poll");
    await assert.rejects(next.client.execute(c.request), /NO_LIVE_INPUT/);
    for (const artifact of c.output.artifacts) await next.command("job.artifact", { ...next.attempt, ...artifact.ref, parts: Math.ceil(artifact.data.length / MEDIA_LIMITS.artifactPartBytes), part: 0,
      data: artifact.data.subarray(0, MEDIA_LIMITS.artifactPartBytes).toString("base64") });
    await next.command("job.result", next.result(c.output.result));
    assert.equal(next.saved.value.receiptAccepted, true);
  } finally { await next.host.close(); }
});

test("audio reads are limited to assigned digest and complete verified input before start", async () => {
  const c = cases()[1], f = await fixture(c);
  try {
    await assert.rejects(f.command("job.artifact.read", { ...f.attempt, digest: c.request.audio.digest, part: 0 }), /INPUT_UNOBSERVED/);
    await f.command("worker.poll"); await f.command("job.input", f.attempt);
    await assert.rejects(f.command("job.artifact.read", { ...f.attempt, digest: "f".repeat(64), part: 0 }), /ARTIFACT_MISMATCH/);
    await assert.rejects(f.command("job.started", f.attempt), /MEDIA_INVALID/);
    await f.command("job.artifact.read", { ...f.attempt, digest: c.request.audio.digest, part: 0 });
    await assert.rejects(f.command("job.started", f.attempt), /MEDIA_INVALID/);
    assert.equal(f.calls.filter(call => call.type === "job.started").length, 0);
    await assert.rejects(f.command("job.usage", { ...f.attempt, promptTokens: 1, final: true }), /TEXT_ONLY/);
  } finally { await f.host.close(); }
});

test("media cancellation reaps the engine before signing a cancelled failure", async () => {
  let running = false;
  const c = cases()[0], f = await fixture(c, { execute: async (_, options) => new Promise((_, reject) => {
    running = true; options.signal.addEventListener("abort", () => { running = false; reject(new AdapterError("ADAPTER_ABORTED_OR_TIMED_OUT")); }, { once: true });
  }) });
  try {
    await f.start(); const abort = new AbortController(), task = f.client.execute(c.request, { signal: abort.signal });
    while (!running) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(f.command("job.failed", { ...f.attempt, reason: "cancelled_locally" }), /FAILURE_UNOBSERVED/);
    abort.abort(); await assert.rejects(task, /ABORTED_OR_TIMED_OUT/);
    assert.equal(running, false); assert.ok(f.stops()); assert.equal(f.saved.value, null);
    await f.command("job.failed", { ...f.attempt, reason: "cancelled_locally" });
  } finally { await f.host.close(); }
});

test("media output limits cannot be bypassed by a forged adapter event or recovery proof", async () => {
  const c = cases()[0], f = await fixture(c);
  try {
    await f.start(); await f.client.execute(c.request);
    const bad = structuredClone(f.saved.value); bad.artifacts[0].data = Buffer.from("forged").toString("base64");
    assert.throws(() => parseWindowsTextExecutionProof(bad, f.assignment.deviceId, f.assignment.capabilityDigest, Date.now()), /MEDIA_INVALID/);
    await assert.rejects(f.client.execute({ ...c.request, kind: "image" }), /./);
    const output = { ...c.output.result, count: 3 };
    await assert.rejects(f.command("job.result", f.result(output)), /./);
  } finally { await f.host.close(); }
});
