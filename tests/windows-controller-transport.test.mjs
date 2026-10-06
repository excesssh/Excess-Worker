import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createWindowsControllerTransport } from "../apps/worker/dist/windows-controller-transport.js";

function fixture() {
  const input = new PassThrough(), frames = [];
  const output = new Writable({ write(bytes, _encoding, callback) { frames.push(JSON.parse(bytes.toString())); callback(); } });
  const rpc = createWindowsControllerTransport(input, output);
  const reply = (id, payload) => input.write(JSON.stringify({ type: "response", id, ok: true, payload }) + "\n");
  return { input, frames, rpc, reply };
}

test("pipe RPC multiplexes four IDs and holds the fifth until a response releases a slot", async () => {
  const f = fixture();
  try {
    const calls = Array.from({ length: 5 }, (_, value) => f.rpc.call("state", { value }));
    assert.equal(f.frames.length, 4);
    f.reply(3, "third"); assert.equal(f.frames.length, 5);
    for (const id of [5, 2, 4, 1]) f.reply(id, id);
    assert.deepEqual(await Promise.all(calls), [1, 2, "third", 4, 5]);
    await f.rpc.finish(); assert.equal(f.frames.at(-1).type, "done");
  } finally { f.rpc.close(); }
});

test("sent cancellation retains an ID so the late valid reply does not become a protocol error", async () => {
  const f = fixture();
  try {
    const abort = new AbortController(), cancelled = f.rpc.call("adapter", { action: "pull" }, abort.signal);
    abort.abort(); await assert.rejects(cancelled, /OPERATION_ABORTED/);
    f.reply(1, "late");
    const next = f.rpc.call("state", { action: "control" }); f.reply(2, "run"); assert.equal(await next, "run");
    await f.rpc.finish();
  } finally { f.rpc.close(); }
});

test("queued cancellation emits no frame and preserves monotonic dispatched IDs", async () => {
  const f = fixture();
  try {
    const calls = Array.from({ length: 4 }, () => f.rpc.call("coordinator", { action: "metadata" }));
    const abort = new AbortController(), queued = f.rpc.call("state", { action: "policy" }, abort.signal);
    abort.abort(); await assert.rejects(queued, /OPERATION_ABORTED/); assert.equal(f.frames.length, 4);
    for (let id = 1; id <= 4; id++) f.reply(id, id); await Promise.all(calls);
    const final = f.rpc.call("state", { action: "control" }); assert.equal(f.frames.at(-1).id, 5); f.reply(5, "run"); await final;
  } finally { f.rpc.close(); }
});

test("unknown, duplicate, malformed, oversized and parent EOF responses close outstanding calls", async () => {
  for (const wire of ['{"type":"response","id":99,"ok":true,"payload":null}\n', '{bad}\n',
    JSON.stringify({ type: "response", id: 1, ok: true, payload: null, extra: true }) + "\n", "x".repeat(1024 * 1024 + 2)]) {
    const f = fixture(); const call = f.rpc.call("state", {});
    f.input.write(wire); await assert.rejects(call, /CONTROLLER_(?:RESPONSE_ID|FRAME)/); f.rpc.close();
  }
  const f = fixture(); const first = f.rpc.call("state", {}); f.reply(1, null); await first;
  const second = f.rpc.call("state", {}); f.reply(1, null); await assert.rejects(second, /RESPONSE_ID_INVALID/); f.rpc.close();
  const ended = fixture(); const pending = ended.rpc.call("state", {}); ended.input.end(); await assert.rejects(pending, /PARENT_EOF/); ended.rpc.close();
});

test("inflight bytes, queued count, selectors, nesting and finish state are bounded", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.rpc.call("exec", {}), /REQUEST_INVALID/);
    await assert.rejects(f.rpc.call("state", { data: "x".repeat(1024 * 1024) }), /INFLIGHT_LIMIT/);
    const calls = Array.from({ length: 20 }, () => f.rpc.call("state", {}));
    await assert.rejects(f.rpc.call("state", {}), /INFLIGHT_LIMIT/);
    await assert.rejects(f.rpc.finish(), /FINISH_INVALID/);
    for (let id = 1; id <= 20; id++) f.reply(id, null); await Promise.all(calls);
  } finally { f.rpc.close(); }
});

test("coalesced large response frames are parsed independently and queued payloads are snapshots", async () => {
  const f = fixture();
  try {
    const payload = "x".repeat(400000);
    const calls = Array.from({ length: 4 }, () => f.rpc.call("state", {}));
    const queued = { action: "original" }, fifth = f.rpc.call("state", queued);
    queued.action = "changed";
    f.input.write([3, 1, 4, 2].map(id => JSON.stringify({ type: "response", id, ok: true, payload }) + "\n").join(""));
    assert.deepEqual(await Promise.all(calls), Array(4).fill(payload));
    assert.equal(f.frames.at(-1).payload.action, "original");
    f.reply(5, null); await fifth; await f.rpc.finish();
    // Closing the transport does not leave subsequent pipe errors unhandled.
    f.input.emit("error", Error("fixture late input error"));
    f.rpc.close();
  } finally { f.rpc.close(); }
});
