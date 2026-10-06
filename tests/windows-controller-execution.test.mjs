import test from "node:test";
import assert from "node:assert/strict";
import { requestDigest } from "../packages/protocol/dist/index.js";
import { createWindowsTextExecutionHost } from "../apps/worker/dist/windows-controller-execution.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const offerId = "44444444-4444-4444-8444-444444444444";
const capabilityDigest = "a".repeat(64);
const nowValue = Date.now();
const request = { prompt: "bounded fixture request", maxTokens: 8, seed: 7 };
const output = { text: "fixture output", generatedTokens: 2, finishReason: "stop" };
const requestHash = requestDigest(request);
const assignment = {
  jobId, attemptId, deviceId, fence: "1", leaseExpiresAt: new Date(nowValue + 60_000).toISOString(),
  runDeadlineAt: new Date(nowValue + 90_000).toISOString(), offerId, capabilityDigest, requestDigest: requestHash, maxUnits: "8",
};
const attempt = { jobId, attemptId, fence: "1" };
const marker = ["aa", "ron"].join("");

function fixture(options = {}) {
  const calls = [], adapterCalls = [], saved = { value: options.proof ?? null }, adapterEvents = [...(options.events ?? [{ kind: "result", result: output, residentMb: 10 }])];
  const coordinator = {
    async handle(payload) {
      calls.push(structuredClone(payload));
      if (payload.action !== "command") return { ok: true, value: null };
      if (payload.type === "worker.poll") return { ok: true, value: { executionEnabled: options.executionEnabled ?? true, assignments: options.assignments ?? [assignment] } };
      if (payload.type === "job.input") return { ok: true, value: { request, requestDigest: requestHash, capabilityDigest, deliveryMode: options.deliveryMode ?? "buffered" } };
      if (payload.type === "job.started" || payload.type === "job.renew") return { ok: true, value: { state: "running", leaseExpiresAt: assignment.leaseExpiresAt } };
      if (payload.type === "job.chunk") return { ok: true, value: { accepted: true, sequence: payload.data.sequence, chunkDigest: payload.data.chunkDigest } };
      if (payload.type === "job.result") return options.resultResponse?.() ?? { ok: true, value: { accepted: true } };
      if (payload.type === "job.failed") return { ok: true, value: { accepted: true } };
      return { ok: true, value: {} };
    },
    async close() {},
  };
  const adapter = {
    async handle(payload) {
      adapterCalls.push(structuredClone(payload));
      if (options.adapterHandle) return options.adapterHandle(payload);
      if (payload.action === "probe" || payload.action === "execute") return { id: payload.action === "probe" ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666" };
      if (payload.action === "pull") return adapterEvents.shift() ?? { kind: "pending", residentMb: 10 };
      if (payload.action === "stop") return { stopped: true };
      throw Error("unexpected adapter action");
    },
    async close() {},
  };
  const proofStore = {
    async load() { return saved.value; },
    async save(value) { saved.value = structuredClone(value); },
    async clear(id) { if (saved.value?.assignment.attemptId === id) saved.value = null; },
  };
  const host = createWindowsTextExecutionHost({ coordinator, adapter, proofStore, deviceId, capabilityDigest, runSeconds: 120, now: () => nowValue });
  const signal = new AbortController().signal;
  const command = (type, data = {}) => host.then(h => h.handleCoordinator({ action: "command", type, data }, signal));
  const adapterCall = payload => host.then(h => h.handleAdapter(payload, signal));
  return { host, command, adapterCall, calls, adapterCalls, saved, signal };
}

function completeResult(attemptData = attempt, value = output) {
  return { ...attemptData, output: value, outputDigest: requestDigest(value), reportedUnits: String(value.generatedTokens) };
}

async function begin(f, deliveryMode = "buffered") {
  await f.command("worker.poll", {});
  await f.command("job.input", attempt);
  await f.command("job.started", attempt);
  await f.adapterCall({ action: "execute", request, streaming: deliveryMode === "stream" });
}

test("host binds adapter execution and result signing to the polled assignment and exact input", async () => {
  const f = fixture();
  try {
    await begin(f);
    await f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 });
    assert.ok(f.saved.value, "observed adapter result is durable before exposure");
    assert.equal(JSON.stringify(f.saved.value).includes(request.prompt), false, "proof stores no prompt");
    await assert.rejects(f.command("job.result", completeResult(attempt, { ...output, text: "invented output" })), /CONTROLLER_EXECUTION_RESULT_MISMATCH/);
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
    const result = await f.command("job.result", completeResult());
    assert.equal(result.ok, true);
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 1);
    assert.equal(f.saved.value.receiptAccepted, true, "host retains exact proof across the child journal crash window");
  } finally { await (await f.host).close(); }
});

test("child cannot execute a prompt different from the coordinator-bound input", async () => {
  const f = fixture();
  try {
    await f.command("worker.poll", {}); await f.command("job.input", attempt); await f.command("job.started", attempt);
    await assert.rejects(f.adapterCall({ action: "execute", request: { ...request, prompt: "changed" }, streaming: false }), /CONTROLLER_EXECUTION_PROMPT_MISMATCH/);
    assert.equal(f.adapterCalls.filter(call => call.action === "execute").length, 0);
  } finally { await (await f.host).close(); }
});

test("duplicate concurrent execute is rejected before a second adapter session can start", async () => {
  let release;
  const f = fixture({ adapterHandle: async payload => {
    if (payload.action === "execute") return await new Promise(resolve => { release = () => resolve({ id: "66666666-6666-4666-8666-666666666666" }); });
    return { kind: "pending", residentMb: 8 };
  } });
  try {
    await f.command("worker.poll", {}); await f.command("job.input", attempt); await f.command("job.started", attempt);
    const first = f.adapterCall({ action: "execute", request, streaming: false });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.adapterCall({ action: "execute", request, streaming: false }), /CONTROLLER_EXECUTION_SESSION_BUSY/);
    assert.equal(f.adapterCalls.filter(call => call.action === "execute").length, 1);
    release(); await first;
  } finally { await (await f.host).close(); }
});

test("stream chunks must be observed from the adapter and acknowledged before result completion", async () => {
  const chunk = { sequence: 1, delta: "streamed", tokenIds: [9, 10], chunkDigest: requestDigest({ sequence: 1, delta: "streamed", tokenIds: [9, 10] }) };
  const streamed = { text: "streamed", generatedTokens: 2, finishReason: "stop" };
  const f = fixture({ deliveryMode: "stream", events: [{ kind: "chunk", chunk, residentMb: 8 }, { kind: "result", result: streamed, residentMb: 8 }] });
  try {
    await begin(f, "stream");
    await assert.rejects(f.command("job.chunk", { ...attempt, ...chunk }), /CONTROLLER_EXECUTION_CHUNK_UNOBSERVED/);
    await f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 });
    await f.command("job.chunk", { ...attempt, ...chunk });
    await f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 1 });
    assert.ok(f.saved.value);
    await f.command("job.result", completeResult(attempt, streamed));
    assert.equal(f.saved.value.receiptAccepted, true);
  } finally { await (await f.host).close(); }
});

test("text-only profile refuses media, artifacts, fabricated usage, and unobserved failures", async () => {
  const f = fixture();
  try {
    for (const type of ["job.usage", "job.artifact", "job.artifact.read"]) {
      await assert.rejects(f.command(type, { ...attempt, promptTokens: 1, final: true }), /CONTROLLER_EXECUTION_TEXT_ONLY/);
    }
    await f.command("worker.poll", {});
    await assert.rejects(f.command("job.failed", { ...attempt, reason: "execution_error" }), /CONTROLLER_EXECUTION_FAILURE_UNOBSERVED/);
    assert.equal(f.calls.filter(call => call.type === "job.failed").length, 0, "denied requests never reach the signing handler");
  } finally { await (await f.host).close(); }
});

test("execution-disabled assignment cannot fetch input or start an adapter; host can report only observed busy", async () => {
  const f = fixture({ executionEnabled: false });
  try {
    await f.command("worker.poll", {});
    await assert.rejects(f.command("job.input", attempt), /CONTROLLER_EXECUTION_STATE_INVALID/);
    await assert.rejects(f.adapterCall({ action: "execute", request, streaming: false }), /CONTROLLER_EXECUTION_NO_LIVE_INPUT/);
    assert.equal(f.calls.filter(call => call.type === "job.input").length, 0);
    assert.equal(f.adapterCalls.filter(call => call.action === "execute").length, 0);
    const failure = await f.command("job.failed", { ...attempt, reason: "busy" });
    assert.equal(failure.ok, true);
    assert.equal(f.calls.filter(call => call.type === "job.failed").length, 1);
  } finally { await (await f.host).close(); }
});

test("lost result receipt resumes from host-persisted output without persisting prompt", async () => {
  const first = fixture({ resultResponse: () => ({ ok: false, status: 503, code: "COORDINATOR_UNAVAILABLE" }) });
  try {
    await begin(first);
    await first.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 });
    await first.command("job.result", completeResult());
    assert.ok(first.saved.value);
    assert.equal(JSON.stringify(first.saved.value).includes(request.prompt), false);
  } finally { await (await first.host).close(); }
  const second = fixture({ proof: first.saved.value, assignments: [] });
  try {
    await second.command("worker.poll", {});
    const result = await second.command("job.result", completeResult());
    assert.equal(result.ok, true);
    assert.equal(second.calls.filter(call => call.type === "job.result").length, 1, "unconfirmed receipt is submitted again");
    assert.equal(second.saved.value.receiptAccepted, true);
  } finally { await (await second.host).close(); }
});

test("new assignment is deferred until a recovered proof is receipted or definitively rejected", async () => {
  const proof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output), completedAt: new Date(nowValue).toISOString() };
  const newer = { ...assignment, jobId: "77777777-7777-4777-8777-777777777777", attemptId: "88888888-8888-4888-8888-888888888888", fence: "2" };
  const nextAttempt = { jobId: newer.jobId, attemptId: newer.attemptId, fence: newer.fence };
  const f = fixture({ proof, assignments: [newer] });
  try {
    await f.command("worker.poll", {});
    await assert.rejects(f.command("job.input", nextAttempt), /CONTROLLER_EXECUTION_NO_ASSIGNMENT/);
    await assert.rejects(f.adapterCall({ action: "execute", request, streaming: false }), /CONTROLLER_EXECUTION_NO_LIVE_INPUT/);
    await f.command("job.result", completeResult());
    await f.command("job.input", nextAttempt);
    assert.equal(f.saved.value, null, "proof is retired only after the child advances to the newer input");
    await f.command("job.started", nextAttempt);
    await f.adapterCall({ action: "execute", request, streaming: false });
    assert.equal(f.adapterCalls.filter(call => call.action === "execute").length, 1);
  } finally { await (await f.host).close(); }
});

test("restart after adapter output but before child journal update submits only the host-stored result", async () => {
  const proof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output), completedAt: new Date(nowValue).toISOString() };
  const f = fixture({ proof });
  try {
    await f.command("worker.poll", {});
    await assert.rejects(f.command("job.input", attempt), /CONTROLLER_EXECUTION_NO_ASSIGNMENT/);
    await assert.rejects(f.adapterCall({ action: "execute", request, streaming: false }), /CONTROLLER_EXECUTION_NO_LIVE_INPUT/);
    assert.ok(f.saved.value, "same-attempt poll cannot retire or re-execute a pending proof");
    await f.command("job.failed", { ...attempt, reason: "cancelled_locally" });
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 1);
    assert.equal(f.calls.filter(call => call.type === "job.failed").length, 0);
    assert.equal(f.calls.find(call => call.type === "job.result").data.outputDigest, requestDigest(output));
    assert.equal(f.saved.value.receiptAccepted, true);
  } finally { await (await f.host).close(); }
});

test("loaded proof must remain inside the signed assignment units and deadline", async () => {
  const invalidProof = { assignment, inputDigest: "b".repeat(64), output: { ...output, generatedTokens: 9 },
    outputDigest: requestDigest({ ...output, generatedTokens: 9 }), completedAt: new Date(nowValue + 100_000).toISOString() };
  const f = fixture({ proof: invalidProof, assignments: [] });
  try {
    await assert.rejects(f.command("worker.poll", {}), /CONTROLLER_EXECUTION_PROOF_INVALID/);
    assert.equal(f.calls.length, 0);
  } finally { await (await f.host).close(); }
});

test("accepted receipt survives a second restart and retires only on authoritative newer input", async () => {
  const acceptedProof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output),
    completedAt: new Date(nowValue).toISOString(), receiptAccepted: true };
  const newer = { ...assignment, jobId: "77777777-7777-4777-8777-777777777777", attemptId: "88888888-8888-4888-8888-888888888888", fence: "2" };
  const nextAttempt = { jobId: newer.jobId, attemptId: newer.attemptId, fence: newer.fence };
  const f = fixture({ proof: acceptedProof, assignments: [newer] });
  try {
    await f.command("worker.poll", {});
    await f.command("job.result", completeResult());
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
    await f.command("job.input", nextAttempt);
    assert.equal(f.saved.value, null);
    assert.equal(f.calls.filter(call => call.type === "job.input").length, 1);
  } finally { await (await f.host).close(); }
});

test("same-attempt poll and input cannot retire accepted proof before result replay", async () => {
  const acceptedProof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output),
    completedAt: new Date(nowValue).toISOString(), receiptAccepted: true };
  const f = fixture({ proof: acceptedProof, assignments: [assignment] });
  try {
    await f.command("worker.poll", {});
    await assert.rejects(f.command("job.input", attempt), /CONTROLLER_EXECUTION_NO_ASSIGNMENT/);
    assert.equal(f.saved.value.receiptAccepted, true);
    await f.command("job.result", completeResult());
    assert.equal(f.calls.filter(call => call.type === "job.result").length, 0);
    assert.equal(f.saved.value.receiptAccepted, true);
  } finally { await (await f.host).close(); }
});

test("deferred assignment retains execution-disabled state after older proof recovery", async () => {
  const proof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output),
    completedAt: new Date(nowValue).toISOString() };
  const newer = { ...assignment, jobId: "77777777-7777-4777-8777-777777777777", attemptId: "88888888-8888-4888-8888-888888888888", fence: "2" };
  const nextAttempt = { jobId: newer.jobId, attemptId: newer.attemptId, fence: newer.fence };
  const f = fixture({ proof, assignments: [newer], executionEnabled: false });
  try {
    await f.command("worker.poll", {});
    await f.command("job.result", completeResult());
    assert.equal(f.saved.value.receiptAccepted, true);
    await assert.rejects(f.command("job.input", nextAttempt), /CONTROLLER_EXECUTION_STATE_INVALID/);
    assert.equal(f.calls.filter(call => call.type === "job.input").length, 0);
    assert.equal(f.saved.value, null, "older accepted proof retires only as newer assignment advances");
  } finally { await (await f.host).close(); }
});

test("stale recovered result rejection clears only its proof and does not block a newer assignment", async () => {
  const proof = { assignment, inputDigest: "b".repeat(64), output, outputDigest: requestDigest(output), completedAt: new Date(nowValue).toISOString() };
  const newer = { ...assignment, jobId: "77777777-7777-4777-8777-777777777777", attemptId: "88888888-8888-4888-8888-888888888888", fence: "2" };
  const f = fixture({ proof, assignments: [newer], resultResponse: () => ({ ok: false, status: 409, code: "RESULT_REJECTED" }) });
  try {
    await f.command("worker.poll", {});
    await f.command("job.result", completeResult());
    assert.equal(f.saved.value, null);
    await assert.rejects(f.command("job.input", attempt), /CONTROLLER_EXECUTION_ATTEMPT_MISMATCH/);
  } finally { await (await f.host).close(); }
});

test("attempt cleared during an awaited adapter pull cannot persist or authorize a stale result", async () => {
  let release;
  const f = fixture({ adapterHandle: async payload => {
    if (payload.action === "execute") return { id: "66666666-6666-4666-8666-666666666666" };
    if (payload.action === "pull") return await new Promise(resolve => { release = () => resolve({ kind: "result", result: output, residentMb: 8 }); });
    if (payload.action === "stop") return { stopped: true };
    throw Error("unexpected adapter action");
  } });
  try {
    await begin(f);
    const pulling = f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 });
    await new Promise(resolve => setImmediate(resolve));
    await f.adapterCall({ action: "stop" });
    await f.command("job.failed", { ...attempt, reason: "cancelled_locally" });
    release();
    await assert.rejects(pulling, /CONTROLLER_EXECUTION_STATE_CHANGED/);
    assert.equal(f.saved.value, null);
  } finally { await (await f.host).close(); }
});

test("close drains in-flight adapter handlers and prevents post-close proof mutation", async () => {
  let release;
  const f = fixture({ adapterHandle: async payload => {
    if (payload.action === "execute") return { id: "66666666-6666-4666-8666-666666666666" };
    if (payload.action === "pull") return await new Promise(resolve => { release = () => resolve({ kind: "result", result: output, residentMb: 8 }); });
    if (payload.action === "stop") return { stopped: true };
    throw Error("unexpected adapter action");
  } });
  try {
    await begin(f);
    const pulling = f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 });
    await new Promise(resolve => setImmediate(resolve));
    let closed = false; const closing = (await f.host).close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(); await assert.rejects(pulling, /CONTROLLER_EXECUTION_(?:CLOSED|STATE_CHANGED)/);
    await closing; assert.equal(closed, true); assert.equal(f.saved.value, null);
  } finally { await (await f.host).close(); }
});

test("host rejects owner-marker output before persisting recovery proof", async () => {
  const privateOutput = { ...output, text: "private marker: " + marker };
  const f = fixture({ events: [{ kind: "result", result: privateOutput, residentMb: 8 }] });
  try {
    await begin(f);
    await assert.rejects(f.adapterCall({ action: "pull", id: "66666666-6666-4666-8666-666666666666", ack: 0 }), /CONTROLLER_EXECUTION_OUTPUT_PRIVACY/);
    assert.equal(f.saved.value, null);
  } finally { await (await f.host).close(); }
});

test("probe is host-observed but can never authorize a job receipt", async () => {
  const f = fixture({ events: [{ kind: "probe", proof: { ok: true, capabilityDigest, threads: 1, maxMemoryMb: 1024, generatedTokens: 1, peakRssMb: 64 }, residentMb: 64 }] });
  try {
    await f.adapterCall({ action: "probe" });
    await f.adapterCall({ action: "pull", id: "55555555-5555-4555-8555-555555555555", ack: 0 });
    assert.equal(f.saved.value, null);
    await assert.rejects(f.command("job.result", completeResult()), /CONTROLLER_EXECUTION_RESULT_UNOBSERVED/);
  } finally { await (await f.host).close(); }
});
