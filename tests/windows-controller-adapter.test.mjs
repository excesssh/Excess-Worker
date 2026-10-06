import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWindowsAdapterHost, createWindowsTextAdapterClient } from "../apps/worker/dist/windows-controller-adapter.js";
import { capabilityDigest, TEXT_CAPABILITY, AdapterError } from "../packages/adapters/dist/index.js";
import { requestDigest } from "../packages/protocol/dist/index.js";

// Protocol fixtures only. No fixture observation verifies hardware execution.
const request = { prompt: "EXCESS protocol fixture", maxTokens: 8, seed: 42 };
const result = { text: "ready", generatedTokens: 1, finishReason: "stop" };
const chunk = { sequence: 1, delta: "ready", tokenIds: [42], chunkDigest: requestDigest({ sequence: 1, delta: "ready", tokenIds: [42] }) };
const signal = () => new AbortController().signal;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async check => { for (let i = 0; i < 500; i++) { if (check()) return; await sleep(2); } throw Error("FIXTURE_WAIT_FAILED"); };
function fixture(overrides = {}) {
  let stops = 0;
  const adapter = { supportsStreaming: true, residentMb: () => 256,
    probe: async () => ({ ok: true, capabilityDigest, backend: "cpu", model: TEXT_CAPABILITY.model, runtime: TEXT_CAPABILITY.runtime,
      threads: 1, maxMemoryMb: 4096, probedAt: new Date().toISOString(), generatedTokens: 1, peakRssMb: 256 }),
    execute: async (value, options) => { assert.deepEqual(value, request); if (options.onChunk) await options.onChunk(chunk); return result; },
    stop: async () => { stops++; }, ...overrides };
  const host = createWindowsAdapterHost(adapter, 2);
  const client = createWindowsTextAdapterClient((payload, abort) => host.handle(payload, abort ?? signal()));
  return { host, client, stops: () => stops };
}

test("typed adapter facade returns validated probe/result and retains one chunk until accepted", async () => {
  let accepted = false, executionReturned = false;
  const f = fixture({ execute: async (_, options) => { await options.onChunk(chunk); assert.equal(accepted, true); executionReturned = true; return result; } });
  try {
    assert.equal((await f.client.probe()).capabilityDigest, capabilityDigest);
    assert.equal(f.client.residentMb(), 256);
    let release;
    const acceptedChunk = new Promise(resolve => { release = resolve; });
    const execution = f.client.execute(request, { onChunk: async value => { assert.deepEqual(value, chunk); await acceptedChunk; accepted = true; } });
    await sleep(20); assert.equal(executionReturned, false);
    release(); assert.deepEqual(await execution, result); assert.equal(executionReturned, true);
    await f.client.stop(); assert.equal(f.client.residentMb(), 0);
  } finally { await f.host.close(); }
});

test("one bounded session rejects arbitrary selectors, extra limits, wrong IDs and replayed acknowledgements", async () => {
  const f = fixture();
  try {
    for (const payload of [{ action: "exec", path: "program" }, { action: "probe", threads: 64 }, { action: "execute", request, streaming: "yes" }])
      await assert.rejects(f.host.handle(payload, signal()), /CONTROLLER_ADAPTER_INVALID/);
    const { id } = await f.host.handle({ action: "execute", request, streaming: true }, signal());
    await assert.rejects(f.host.handle({ action: "probe" }, signal()), /CONTROLLER_ADAPTER_BUSY/);
    await assert.rejects(f.host.handle({ action: "pull", id: randomUUID(), ack: 0 }, signal()), /SESSION_INVALID/);
    const first = await f.host.handle({ action: "pull", id, ack: 0 }, signal()); assert.equal(first.kind, "chunk");
    await assert.rejects(f.host.handle({ action: "pull", id, ack: 0 }, signal()), /ACK_INVALID/);
    await assert.rejects(f.host.handle({ action: "pull", id, ack: 2 }, signal()), /ACK_INVALID/);
    assert.equal((await f.host.handle({ action: "pull", id, ack: 1 }, signal())).kind, "result");
    await assert.rejects(f.host.handle({ action: "pull", id, ack: 1 }, signal()), /SESSION_INVALID/);
  } finally { await f.host.close(); }
});

test("concurrent pull is refused without losing the active request", async () => {
  let complete;
  const f = fixture({ execute: () => new Promise(resolve => { complete = resolve; }) });
  try {
    const { id } = await f.host.handle({ action: "execute", request, streaming: false }, signal());
    const pull = f.host.handle({ action: "pull", id, ack: 0 }, signal());
    await assert.rejects(f.host.handle({ action: "pull", id, ack: 0 }, signal()), /ACK_INVALID/);
    await wait(() => !!complete); complete(result);
    assert.equal((await pull).kind, "result");
  } finally { await f.host.close(); }
});

test("stop interrupts a chunk awaiting acknowledgement and allows a fresh session", async () => {
  let callbacks = 0;
  const f = fixture({ execute: async (_, options) => { await options.onChunk(chunk); callbacks++; return result; } });
  try {
    const { id } = await f.host.handle({ action: "execute", request, streaming: true }, signal());
    assert.equal((await f.host.handle({ action: "pull", id, ack: 0 }, signal())).kind, "chunk");
    await f.host.handle({ action: "stop" }, signal()); assert.equal(callbacks, 0); assert.equal(f.stops(), 1);
    assert.equal((await f.client.probe()).ok, true);
  } finally { await f.host.close(); }
});

test("client cancellation stops a pending engine and surfaces a fixed abort code", async () => {
  let running = false;
  const f = fixture({ execute: (_, options) => new Promise((resolve, reject) => {
    running = true;
    options.signal.addEventListener("abort", () => { running = false; reject(new AdapterError("ADAPTER_ABORTED_OR_TIMED_OUT")); }, { once: true });
  }) });
  try {
    const abort = new AbortController(); const execution = f.client.execute(request, { signal: abort.signal });
    await wait(() => running); abort.abort();
    await assert.rejects(execution, /ADAPTER_ABORTED_OR_TIMED_OUT/); assert.equal(running, false); assert.ok(f.stops() > 0);
  } finally { await f.host.close(); }
});

test("unknown engine exceptions stay private and closing is idempotent", async () => {
  const f = fixture({ execute: async () => { throw Error("private fixture detail"); } });
  await assert.rejects(f.client.execute(request), /CONTROLLER_ADAPTER_FAILED/);
  await Promise.all([f.host.close(), f.host.close()]);
  await assert.rejects(f.host.handle({ action: "probe" }, signal()), /CONTROLLER_ADAPTER_CLOSED/);
});
