import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MEDIA_CATALOG, WINDOWS_MEDIA_CPU_BUDGETS, catalogEntry } from "../packages/adapters/dist/index.js";
import { createTextAdapterWith } from "../packages/adapters/dist/runtime.js";
import { createMediaAdapterWith } from "../packages/adapters/dist/media-runtime.js";
import { MAX_RUNTIME_HELPER_LIFETIME_MS, linuxRuntimeHelperTimeoutSeconds, runtimeHelperCoversJobDeadline,
  windowsRuntimeHelperTimeoutMilliseconds } from "../packages/adapters/dist/runtime-lifetime.js";

const textServer = resolve("tests/fixtures/fake-llama-text-server.mjs");
const mediaServer = resolve("tests/fixtures/fake-media-server.mjs");
const MiB = 1024 * 1024;

async function temporary(run) {
  const parent = resolve(".cache"); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "runtime-lifetime-test-"));
  try { return await run(dir); }
  finally { assert.equal(dirname(dir), parent); assert.ok(basename(dir).startsWith("runtime-lifetime-test-")); await rm(dir, { recursive: true, force: true }); }
}

function fixtureIsolation(executable, calls, cleanups, scratch) {
  return async (_requestedExecutable, args, options) => {
    calls.push(options.timeoutMs);
    return { executable: process.execPath, args: [executable, ...args], scratch, profile: "fixture-only",
      cleanup: async () => { cleanups.count++; } };
  };
}

test("helper timeout conversions preserve native limits and reject expiry at a job deadline", () => {
  assert.equal(MAX_RUNTIME_HELPER_LIFETIME_MS, 600_000);
  assert.equal(linuxRuntimeHelperTimeoutSeconds(MAX_RUNTIME_HELPER_LIFETIME_MS), 605, "Linux keeps its five-second native cleanup allowance");
  assert.equal(windowsRuntimeHelperTimeoutMilliseconds(MAX_RUNTIME_HELPER_LIFETIME_MS), 600_000);
  assert.equal(runtimeHelperCoversJobDeadline(1_000, 600_999), true);
  assert.equal(runtimeHelperCoversJobDeadline(1_000, 601_000), false, "equal expiry must trigger a restart");
});

test("text adapter refreshes an aging isolated helper and still enforces each job timeout", { timeout: 30_000 }, async t => temporary(async dir => {
  const config = join(dir, "text-config.json"), log = join(dir, "text-log.jsonl");
  await writeFile(config, JSON.stringify({ log, output: [[1, "fixture answer"]] }));
  const textEntry = catalogEntry("phi-4-mini"), memoryMb = Math.max(1024, textEntry.minMemoryMb);
  if (memoryMb * MiB > totalmem()) { t.skip("fixture host is below the selected model's memory floor"); return; }
  const isolations = [], cleanups = { count: 0 }; let now = 1_000;
  const adapter = createTextAdapterWith({ threads: 1, maxMemoryMb: memoryMb, timeoutMs: 5_000, modelId: "phi-4-mini", backend: "cpu" }, {
    isolate: true, executable: process.execPath, now: () => now,
    resolve: async () => ({ serverPath: textServer, modelPath: config }),
    isolateRuntime: fixtureIsolation(textServer, isolations, cleanups, dir),
  });
  try {
    const request = { prompt: "fixture input", maxTokens: 8, seed: 42 };
    assert.equal((await adapter.execute(request)).text, "fixture answer");
    now += 596_000;
    assert.equal((await adapter.execute(request)).text, "fixture answer");
    assert.deepEqual(isolations, [MAX_RUNTIME_HELPER_LIFETIME_MS, MAX_RUNTIME_HELPER_LIFETIME_MS]);
    assert.equal(cleanups.count, 1, "the old helper is stopped and cleaned before replacement");
    await writeFile(config, JSON.stringify({ log, behavior: "hang" }));
    await assert.rejects(adapter.execute(request), /ADAPTER_ABORTED_OR_TIMED_OUT/);
  } finally { await adapter.stop(); }
  const starts = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.type === "start");
  assert.equal(starts.length, 2, "the timed-out job reaps its reused helper");
}));

test("media adapter refreshes an aging isolated helper and still enforces each job timeout", { timeout: 30_000 }, async t => temporary(async dir => {
  const config = join(dir, "media-config.json"), log = join(dir, "media-log.jsonl");
  await writeFile(config, JSON.stringify({ log }));
  const entry = MEDIA_CATALOG.find(item => item.id === "qwen3-embedding-0.6b");
  assert.ok(entry);
  const memoryMb = Math.max(1024, entry.minMemoryMb, WINDOWS_MEDIA_CPU_BUDGETS[entry.id]?.maxMemoryMb ?? 0);
  if (memoryMb * MiB > totalmem()) { t.skip("fixture host is below the selected model's memory floor"); return; }
  const files = Object.fromEntries(entry.artifacts.map(artifact => [artifact.name, config]));
  const isolations = [], cleanups = { count: 0 }; let now = 1_000;
  const adapter = createMediaAdapterWith({ threads: 1, maxMemoryMb: memoryMb, timeoutMs: 5_000, modelId: entry.id, backend: "cpu" }, {
    isolate: true, executable: process.execPath, now: () => now,
    resolve: async () => ({ serverPath: mediaServer, files }),
    isolateRuntime: fixtureIsolation(mediaServer, isolations, cleanups, dir),
  });
  try {
    const request = { kind: "embedding", inputs: ["fixture input"] };
    assert.equal((await adapter.execute(request)).result.kind, "embedding");
    now += 596_000;
    assert.equal((await adapter.execute(request)).result.kind, "embedding");
    assert.deepEqual(isolations, [MAX_RUNTIME_HELPER_LIFETIME_MS, MAX_RUNTIME_HELPER_LIFETIME_MS]);
    assert.equal(cleanups.count, 1, "the old helper is stopped and cleaned before replacement");
    await writeFile(config, JSON.stringify({ log, behavior: "hang" }));
    await assert.rejects(adapter.execute(request), /ADAPTER_ABORTED_OR_TIMED_OUT/);
  } finally { await adapter.stop(); }
  const starts = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse).filter(row => row.type === "start");
  assert.equal(starts.length, 2, "the timed-out job reaps its reused helper");
}));
