import test from "node:test";
import assert from "node:assert/strict";
import { __testOnlyCreateControllerUpdatePlan } from "../apps/worker/dist/controller-update.js";

const current = "1.2.3-0123456789ab";
const latest = "1.2.4-acde01234567";
const revision = "00000000-0000-4000-8000-000000000007";
const status = () => ({ current, latest, available: true, checkedAt: new Date().toISOString() });

function makePlan(overrides = {}) {
  let now = Date.now(), installs = 0, checks = 0, snapshot = { mode: "run", revision };
  const options = {
    autoUpdate: true, supervised: true, current,
    async check(signal) { checks++; assert.equal(signal.aborted, false); return status(); },
    async readControl(signal) { assert.equal(signal.aborted, false); return snapshot; },
    async install(signal, expectedRevision) { installs++; assert.equal(signal.aborted, false); assert.equal(expectedRevision, revision); return 0; },
    ...overrides,
  };
  const plan = __testOnlyCreateControllerUpdatePlan(options, () => now);
  return { plan, options, setNow(value) { now = value; }, setSnapshot(value) { snapshot = value; }, get installs() { return installs; }, get checks() { return checks; } };
}

async function authorize(plan) {
  const signal = new AbortController().signal;
  const checked = await plan.callbacks.check(signal);
  assert.equal(checked.available, true);
  assert.equal(await plan.callbacks.requestInstall(signal), 0);
}

test("host update callbacks are exposed only for enabled supervised signed releases", () => {
  assert.equal(__testOnlyCreateControllerUpdatePlan({ autoUpdate: false, supervised: true, current, check() {}, readControl() {}, install() {} }, () => 0), undefined);
  assert.equal(__testOnlyCreateControllerUpdatePlan({ autoUpdate: true, supervised: false, current, check() {}, readControl() {}, install() {} }, () => 0), undefined);
  assert.equal(__testOnlyCreateControllerUpdatePlan({ autoUpdate: true, supervised: true, current: null, check() {}, readControl() {}, install() {} }, () => 0), undefined);
  assert.equal(__testOnlyCreateControllerUpdatePlan({ autoUpdate: true, supervised: true, current: "invalid", check() {}, readControl() {}, install() {} }, () => 0), undefined);
});

test("intent is recorded first and installation waits for clean reap, updated status and final revision check", async () => {
  const fixture = makePlan();
  assert.ok(fixture.plan);
  await authorize(fixture.plan);
  assert.equal(fixture.installs, 0);
  // Controller's normal teardown may set mode=stop while preserving the explicit-control revision.
  fixture.setSnapshot({ mode: "stop", revision });
  assert.equal(await fixture.plan.finish({ run: { code: 0, cleaned: true }, status: { reason: "updated" }, signal: new AbortController().signal }), 75);
  assert.equal(fixture.installs, 1);
});

test("bad exit, unconfirmed cleanup, wrong status, abort, or explicit control revision change never installs", async () => {
  const cases = [
    { run: { code: 0, cleaned: false }, status: { reason: "updated" }, change: false, abort: false },
    { run: { code: 1, cleaned: true }, status: { reason: "updated" }, change: false, abort: false },
    { run: { code: null, cleaned: true }, status: { reason: "updated" }, change: false, abort: false },
    { run: { code: 0, cleaned: true }, status: { reason: "stopped_locally" }, change: false, abort: false },
    { run: { code: 0, cleaned: true }, status: { reason: "updated" }, change: true, abort: false },
    { run: { code: 0, cleaned: true }, status: { reason: "updated" }, change: false, abort: true },
  ];
  for (const item of cases) {
    const fixture = makePlan();
    await authorize(fixture.plan);
    if (item.change) fixture.setSnapshot({ mode: "stop", revision: "00000000-0000-4000-8000-000000000008" });
    const controller = new AbortController();
    if (item.abort) controller.abort();
    assert.equal(await fixture.plan.finish({ run: item.run, status: item.status, signal: controller.signal }), undefined);
    assert.equal(fixture.installs, 0);
  }
});

test("stop or drain during the available check blocks new install intent", async () => {
  for (const [mode, changedRevision] of [["stop", "00000000-0000-4000-8000-000000000008"], ["drain", "00000000-0000-4000-8000-000000000009"]]) {
    let snapshot = { mode: "run", revision };
    const fixture = makePlan({ async readControl() { return snapshot; } });
    const signal = new AbortController().signal;
    await fixture.plan.callbacks.check(signal);
    snapshot = { mode, revision: changedRevision };
    assert.equal(await fixture.plan.callbacks.requestInstall(signal), 1);
    assert.equal(fixture.installs, 0);
  }
});

test("non-available, stale, malformed, or aborted checks cannot create install intent", async () => {
  const unavailable = makePlan({ async check() { return { current, latest: current, available: false, checkedAt: new Date().toISOString() }; } });
  await unavailable.plan.callbacks.check(new AbortController().signal);
  assert.equal(await unavailable.plan.callbacks.requestInstall(new AbortController().signal), 1);

  const stale = makePlan();
  await stale.plan.callbacks.check(new AbortController().signal);
  stale.setNow(Date.now() + 15 * 60 * 1000 + 1);
  assert.equal(await stale.plan.callbacks.requestInstall(new AbortController().signal), 1);

  const malformed = makePlan({ async check() { return { ...status(), origin: "https://untrusted.invalid" }; } });
  await assert.rejects(malformed.plan.callbacks.check(new AbortController().signal), /CONTROLLER_UPDATE_CHECK_INVALID/);

  const oldCheck = makePlan({ async check() { return { ...status(), checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() }; } });
  await assert.rejects(oldCheck.plan.callbacks.check(new AbortController().signal), /CONTROLLER_UPDATE_CHECK_STALE/);

  const aborted = makePlan();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(aborted.plan.callbacks.check(controller.signal), /CONTROLLER_UPDATE_ABORTED/);
  assert.equal(aborted.checks, 0);
});

test("finish rejects stale intent and reports installation failures without restart", async () => {
  const stale = makePlan();
  await authorize(stale.plan);
  stale.setNow(Date.now() + 15 * 60 * 1000 + 1);
  assert.equal(await stale.plan.finish({ run: { code: 0, cleaned: true }, status: { reason: "updated" }, signal: new AbortController().signal }), undefined);
  assert.equal(stale.installs, 0);

  const failed = makePlan({ async install() { return 1; } });
  await authorize(failed.plan);
  assert.equal(await failed.plan.finish({ run: { code: 0, cleaned: true }, status: { reason: "updated" }, signal: new AbortController().signal }), 1);

  let expected;
  const vetoed = makePlan({ async install(_signal, revisionAtStart) { expected = revisionAtStart; return undefined; } });
  await authorize(vetoed.plan);
  assert.equal(await vetoed.plan.finish({ run: { code: 0, cleaned: true }, status: { reason: "updated" }, signal: new AbortController().signal }), undefined);
  assert.equal(expected, revision);

  const throws = makePlan({ async install() { throw new Error("private updater detail"); } });
  await authorize(throws.plan);
  assert.equal(await throws.plan.finish({ run: { code: 0, cleaned: true }, status: { reason: "updated" }, signal: new AbortController().signal }), 1);
});
