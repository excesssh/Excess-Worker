import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateControllerBudget, requireControllerBudget } from "../apps/worker/dist/controller-budget.js";
import { configuredControllerOrigin, saveControllerOrigin } from "../apps/worker/dist/controller-config.js";
import { startLinuxController } from "../apps/worker/dist/controller.js";

const origin = "https://worker.example";
const keyA = Buffer.alloc(48, 0x41).toString("base64");
const keyB = Buffer.alloc(48, 0x42).toString("base64");

test("controller budget accepts only bounded dedicated cgroup values", () => {
  assert.equal(validateControllerBudget("8589934592\n", "0\n", "64\n", "200 100\n"), undefined);
  for (const values of [
    ["max", "0", "64", "200 100"],
    ["8589934592", "1", "64", "200 100"],
    ["8589934592", "0", "129", "200 100"],
    ["8589934592", "0", "64", "201 100"],
    ["8589934592", "0", "64", "max 100"],
  ]) assert.throws(() => validateControllerBudget(...values), /CONTROLLER_RESOURCE_BOUNDARY_REQUIRED/);
});

test("controller bootstrap requires Linux x64 and a dedicated budgeted service cgroup", async () => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    await assert.rejects(startLinuxController({ packageDir: ".", installDir: ".", stateDir: ".", origin }), /CONTROLLER_ISOLATION_UNAVAILABLE/);
    return;
  }
  let budgetAccepted = false;
  try { await requireControllerBudget(); budgetAccepted = true; }
  catch (error) { assert.match(error.message, /CONTROLLER_RESOURCE_BOUNDARY_REQUIRED/); }
  if (!budgetAccepted) {
    await assert.rejects(startLinuxController({ packageDir: ".", installDir: ".", stateDir: ".", origin }), /CONTROLLER_RESOURCE_BOUNDARY_REQUIRED/);
  } else {
    await assert.rejects(startLinuxController({ packageDir: ".", installDir: "./ai", stateDir: "./state", origin }), /CONTROLLER_PATH_INVALID/);
  }
});

test("paired origin policy is bound to the identity public key and rejects tampering", async t => {
  if (process.platform !== "linux") return t.skip("controller config is Linux-only");
  const base = await mkdtemp(join(tmpdir(), "excess-controller-config-test-"));
  const state = join(base, "worker-state");
  const policy = join(base, ".excess-worker-controller");
  await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  await saveControllerOrigin(state, origin, keyA);
  assert.equal(await configuredControllerOrigin(state, origin, keyA), origin);
  await assert.rejects(configuredControllerOrigin(state, "https://other.example", keyA), /CONTROLLER_SETUP_REQUIRED/);
  await assert.rejects(configuredControllerOrigin(state, origin, keyB), /CONTROLLER_SETUP_REQUIRED/);
  await assert.rejects(saveControllerOrigin(state, origin, "not-base64!"), /CONTROLLER_CONFIG_INVALID/);
  const file = join(policy, (await readdir(policy))[0]);
  const original = await readFile(file, "utf8");
  await writeFile(file, JSON.stringify({ format: 1, origin: "https://other.example", fingerprint: JSON.parse(original).fingerprint }) + "\n", { mode: 0o600 });
  await assert.rejects(configuredControllerOrigin(state, origin, keyA), /CONTROLLER_SETUP_REQUIRED/);
});
