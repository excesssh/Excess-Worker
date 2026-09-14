import test from "node:test";
import assert from "node:assert/strict";
import { readLlamaStream } from "../packages/adapters/dist/stream.js";
import { requestDigest } from "../packages/protocol/dist/index.js";

// Synthetic native llama.cpp SSE bytes only. These parser tests do not load a
// model and are not evidence of model output, token IDs, or hardware capacity.
const partial = (content, tokens, tokens_predicted) => ({ content, tokens, stop: false, tokens_predicted });
const final = (tokens_predicted, extra = {}) => ({ content: "", tokens: [], stop: true, tokens_predicted, stop_type: "limit", truncated: false, ...extra });
const frame = (value, eol = "\n") => "data: " + JSON.stringify(value) + eol + eol;
const response = text => new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("synthetic llama SSE coalesces incrementally and awaits chunk persistence backpressure", async () => {
  const ready = deferred(), release = deferred(), emitted = [];
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const pending = readLlamaStream(response(body), 16, async chunk => {
    emitted.push(chunk); if (chunk.sequence === 1) { ready.resolve(); await release.promise; }
  });
  controller.enqueue(Buffer.from(Array.from({ length: 16 }, (_, i) => frame(partial(String(i % 10), [100 + i], i + 1))).join("")));
  await ready.promise;
  assert.equal(emitted.length, 1, "first callback arrives while the SSE body remains open");
  assert.equal(emitted[0].tokenIds.length, 8);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(emitted.length, 1, "the next callback waits for the first acknowledgement");
  release.resolve();
  controller.enqueue(Buffer.from(frame(final(16)))); controller.close();
  const result = await pending;
  assert.deepEqual(result, { text: "0123456789012345", generatedTokens: 16, finishReason: "length" });
  assert.deepEqual(emitted.map(value => value.tokenIds.length), [8, 8]);
  for (const { chunkDigest, ...chunk } of emitted) assert.equal(chunkDigest, requestDigest(chunk));
});

test("synthetic llama SSE decodes split UTF-8, SSE line boundaries and empty token text", async () => {
  const wire = Buffer.from(": test comment\r\n\r\n" + frame(partial("é🙂", [1], 1), "\r\n") +
    frame(partial("", [2], 2), "\r") + frame(final(2, { stop_type: "eos" })));
  const body = new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const chunks = [];
  assert.deepEqual(await readLlamaStream(response(body), 8, async chunk => { chunks.push(chunk); }),
    { text: "é🙂", generatedTokens: 2, finishReason: "stop" });
  assert.deepEqual(chunks[0].tokenIds, [1, 2]);
  assert.equal(chunks[0].delta, "é🙂");
  const multiline = 'data: {"content":"fixture",\ndata: "tokens":[3],"stop":false,"tokens_predicted":1}\n\n';
  assert.equal((await readLlamaStream(response(multiline + frame(final(1))), 1, async () => {})).text, "fixture");
});

test("synthetic llama SSE rejects incomplete, reordered, oversized or inconsistent runtime evidence", async () => {
  const first = frame(partial("fixture", [1], 1)), end = frame(final(1));
  const cases = [
    ["missing final", first], ["unterminated event", first + end.trimEnd()],
    ["duplicate final", first + end + end], ["content after final", first + end + first],
    ["OpenAI terminator", first + "data: [DONE]\n\n"], ["wrong SSE event", "event: error\ndata: {}\n\n"],
    ["final count mismatch", first + frame(final(2))], ["cumulative final", first + frame(final(1, { content: "fixture", tokens: [1] }))],
    ["truncated", first + frame(final(1, { truncated: true }))], ["unfinished stop", first + frame(final(1, { stop_type: "none" }))],
    ["token-ID omission", frame(partial("é", [2], 2)) + frame(final(2))],
    ["negative token", frame(partial("fixture", [-1], 1)) + end],
    ["oversized token", frame(partial("fixture", [2147483648], 1)) + end],
    ["zero-token text", frame(partial("fixture", [], 0)) + frame(final(0))],
    ["unpaired surrogate", frame(partial("\ud800", [1], 1)) + end],
    ["UTF-8 output bound", frame(partial("é".repeat(4097), [1], 1)) + end],
    ["aggregate output bound", frame(partial("x".repeat(4096), [1], 1)) + frame(partial("y".repeat(4097), [2], 2)) + frame(final(2))],
    ["request token bound", first + frame(partial("more", [2], 2)) + frame(final(2)), 1],
    ["global token bound", frame(partial("fixture", Array.from({ length: 129 }, (_, i) => i), 129)) + frame(final(129))],
    ["oversized wire", ":" + "x".repeat(262145)],
  ];
  for (const [label, wire, max = 128] of cases) await assert.rejects(readLlamaStream(response(wire), max, async () => {}), undefined, label);
  await assert.rejects(readLlamaStream(new Response(JSON.stringify({ content: "fixture" }), { headers: { "content-type": "application/json" } }), 1, async () => {}));
  await assert.rejects(readLlamaStream(response(Buffer.from([0xc3, 0x28])), 1, async () => {}));
});

test("synthetic llama SSE reaches exact global token/output bounds without buffering all tokens", async () => {
  const wire = Array.from({ length: 128 }, (_, i) => frame(partial("x".repeat(64), [i], i + 1))).join("") + frame(final(128));
  const chunks = [];
  const result = await readLlamaStream(response(wire), 128, async chunk => { chunks.push(chunk); });
  assert.equal(Buffer.byteLength(result.text), 8192); assert.equal(result.generatedTokens, 128);
  assert.equal(chunks.length, 16); assert.ok(chunks.every(chunk => chunk.tokenIds.length === 8));
});

test("synthetic llama SSE cancels the reader on callback failure and abort during reads or callbacks", async () => {
  let cancelled = 0, calls = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame(partial("fixture", [1, 2, 3, 4, 5, 6, 7, 8], 8)))); }, cancel() { cancelled++; } });
  const failure = Error("synthetic persistence failure");
  await assert.rejects(readLlamaStream(response(body), 8, async () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 1); assert.equal(cancelled, 1);
  for (const duringCallback of [false, true]) {
    const controller = new AbortController(), started = deferred(); let cancelCount = 0;
    const waiting = new ReadableStream({ start(stream) {
      if (duringCallback) stream.enqueue(Buffer.from(frame(partial("fixture", [1, 2, 3, 4, 5, 6, 7, 8], 8))));
      else started.resolve();
    }, cancel() { cancelCount++; } });
    const pending = readLlamaStream(response(waiting), 8, async () => { started.resolve(); await new Promise(() => {}); }, controller.signal);
    await started.promise; controller.abort();
    await assert.rejects(pending); assert.equal(cancelCount, 1);
  }
});
