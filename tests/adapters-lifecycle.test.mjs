import test from "node:test";
import assert from "node:assert/strict";
import { AdapterProcessState } from "../packages/adapters/dist/runtime.js";
import { AdapterError } from "../packages/adapters/dist/index.js";

// Synthetic ManagedProcess instances exercise the actual supervisor barrier.
// These tests start no native executable and do not load an installed model.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fakeProcess() {
  const reaped = deferred(); let stops = 0, alive = true;
  return { child: {}, closed: reaped.promise, error: () => null, peakRssBytes: () => 0, nativePid: () => undefined,
    alive: () => alive, async stop() { stops++; await reaped.promise; alive = false; },
    reaped, stops: () => stops };
}

test("adapter shutdown joins concurrent callers and replacement waits for the original process reap", async () => {
  const state = new AdapterProcessState(), original = fakeProcess(), replacement = fakeProcess();
  state.attach(original);
  const first = state.stop(), second = state.stop();
  assert.equal(first, second, "every stop joins the same in-flight barrier");
  let ready = false;
  const pendingRun = state.ready().then(() => { ready = true; state.attach(replacement); });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(original.stops(), 1); assert.equal(ready, false); assert.equal(state.process, original);
  assert.throws(() => state.attach(replacement), { code: "RUNTIME_REPLACEMENT_BLOCKED" });
  original.reaped.resolve();
  await Promise.all([first, second, pendingRun]);
  assert.equal(original.alive(), false); assert.equal(state.process, replacement);
  const stopReplacement = state.stop(); replacement.reaped.resolve(); await stopReplacement;
  assert.equal(replacement.stops(), 1); assert.equal(state.process, undefined);
});

test("adapter reap failure remains joined and blocks every replacement attempt", async () => {
  const state = new AdapterProcessState(), original = fakeProcess(), replacement = fakeProcess();
  state.attach(original);
  const failure = new AdapterError("RUNTIME_STOP_TIMEOUT");
  const first = state.stop(), second = state.stop(), waitingRun = state.ready();
  const checks = Promise.all([first, second, waitingRun].map(value => assert.rejects(value, error => error === failure)));
  original.reaped.reject(failure); await checks;
  assert.equal(original.stops(), 1); assert.equal(original.alive(), true); assert.equal(state.process, original);
  assert.equal(state.stop(), first); await assert.rejects(state.stop(), error => error === failure);
  await assert.rejects(state.ready(), error => error === failure);
  assert.throws(() => state.attach(replacement), { code: "RUNTIME_REPLACEMENT_BLOCKED" });
});
