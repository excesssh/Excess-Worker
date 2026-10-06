import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "@excess/adapters";
import { createControllerStateStore, __testOnlyCreateControllerStateStore } from "../apps/worker/dist/controller-state.js";
import { createWorkerStateReader } from "../apps/worker/dist/controller-state-reader.js";
import { createWindowsStateClient, createWindowsStateHost, __testOnlyCreateWindowsStateHost } from "../apps/worker/dist/windows-controller-state.js";

const attempt = "00000000-0000-4000-8000-000000000001";
const asset = "00000000-0000-4000-8000-000000000002";
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "excess-win-state-")), stateDir = join(base, "state");
  await mkdir(stateDir, { mode: 0o700 });
  if (process.platform === "linux") await chmod(stateDir, 0o700);
  let marks = 0;
  const storeOptions = { stateDir, markShutdownUnverified: async () => { marks++; } };
  const store = options.storeLimits ? await __testOnlyCreateControllerStateStore({ ...storeOptions, limits: options.storeLimits }) : await createControllerStateStore(storeOptions);
  const reader = await createWorkerStateReader({ stateDir });
  const host = options.hostLimits ? __testOnlyCreateWindowsStateHost(reader, store, { limits: options.hostLimits }) : createWindowsStateHost(reader, store);
  const call = (payload, signal = new AbortController().signal) => host.handle(payload, signal);
  const client = createWindowsStateClient(call);
  t.after(async () => { await client.close().catch(() => {}); await host.close().catch(() => {}); await store.close(); await rm(base, { recursive: true, force: true }); });
  return { base, stateDir, store, reader, host, client, call, marks: () => marks };
}
function writeBegin(name, size, kind = "replace") { return { action: "write-begin", kind, name, size }; }

test("typed state client reads policies/offers/outputs and writes only managed state through the store", async t => {
  const { stateDir, client, marks } = await fixture(t);
  assert.equal((await client.reader.readControl()), "stop");
  assert.deepEqual(await client.reader.readOffers(), []);
  await client.writer.replace("status.json", Buffer.from('{"state":"ready"}'));
  await client.writer.replace("offers/" + DEFAULT_MODEL_ID + ".auto.json", Buffer.from(JSON.stringify({ prices: { [asset]: "1.25" } })));
  await client.writer.replace("journal-owner.json", Buffer.from('{"version":1,"deviceId":"device-safe"}'));
  await client.writer.replace(`${attempt}.result.json`, Buffer.from('{"kind":"text","text":"safe"}'));
  const artifact = Buffer.from("local artifact payload");
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  await client.writer.replace(`${attempt}.artifact.${artifactDigest}.bin`, artifact);
  await client.writer.appendJournal(Buffer.from('{"state":"seen"}\n'));
  assert.equal((await client.reader.readAutoPrices()).get(asset), "1.25");
  assert.deepEqual(await client.reader.readJournalOwner(), Buffer.from('{"version":1,"deviceId":"device-safe"}'));
  assert.deepEqual(await client.reader.readJournal(), Buffer.from('{"state":"seen"}\n'));
  assert.deepEqual(await client.reader.readResult(attempt), Buffer.from('{"kind":"text","text":"safe"}'));
  assert.deepEqual(await client.reader.readArtifact(attempt, artifactDigest), artifact);
  assert.deepEqual(await client.reader.listOutputs(attempt), [`${attempt}.artifact.${artifactDigest}.bin`, `${attempt}.result.json`]);
  assert.deepEqual(await readFile(join(stateDir, "status.json")), Buffer.from('{"state":"ready"}'));
  await client.writer.markShutdownUnverified(); assert.equal(marks(), 1);
  await client.writer.removeOutput(`${attempt}.result.json`);
  await assert.rejects(client.reader.readResult(attempt));
});

test("host refuses unknown actions, traversal, malformed selectors, extra fields and noncanonical chunks", async t => {
  const { host, call, stateDir } = await fixture(t);
  const live = () => new AbortController().signal;
  for (const payload of [
    { action: "read-policy", path: "identity.json" }, { action: "read-offers", modelId: "../identity" },
    { action: "snapshot-open", kind: "artifact", attemptId: "../x", digest }, { action: "no-route" },
    { action: "write-begin", kind: "replace", name: "../identity.json", size: 1 },
    { action: "write-begin", kind: "replace", name: "offers/unknown.auto.json", size: 1 },
  ]) await assert.rejects(host.handle(payload, live()));
  const begin = await call(writeBegin("attempts.jsonl", 1));
  await assert.rejects(host.handle({ action: "write-chunk", id: begin.id, offset: 0, bytes: "YQ=" }, live()));
  await assert.rejects(host.handle({ action: "write-commit", id: begin.id }, live()));
  const second = await call(writeBegin("attempts.jsonl", 2));
  await assert.rejects(host.handle({ action: "write-chunk", id: second.id, offset: 1, bytes: "YQ==" }, live()));
  await assert.rejects(host.handle({ action: "write-commit", id: second.id }, live()));
  await assert.rejects(readFile(join(stateDir, "attempts.jsonl")));
});

test("reader selectors reject extra members and corrupted host results fail closed", async t => {
  const { client, host } = await fixture(t);
  await assert.rejects(client.reader.openSnapshot({ kind: "journal", path: "identity.json" }));
  const malformed = createWindowsStateClient(async payload => {
    if (payload.action === "read-control") return "launch";
    if (payload.action === "remove-output") return { removed: false };
    return { ok: true };
  });
  await assert.rejects(malformed.reader.readControl());
  await assert.rejects(malformed.writer.removeOutput(`${attempt}.result.json`));
  await host.close();
});

test("snapshot streaming enforces sequential 64 KiB chunks, digest and host aggregate ceilings", async t => {
  const { client } = await fixture(t, { hostLimits: { snapshotHandles: 2, snapshotBytes: 24 } });
  const bytes = Buffer.from("0123456789abcdefghij");
  await client.writer.replace(`${attempt}.result.json`, bytes);
  const first = await client.reader.openSnapshot({ kind: "result", attemptId: attempt });
  assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
  await assert.rejects(client.reader.readSnapshot(first.id, 1, 5));
  const read = await client.reader.readSnapshot(first.id, 0, 7);
  assert.deepEqual(read, bytes.subarray(0, 7));
  const rest = await client.reader.readSnapshot(first.id, 7, 13);
  assert.deepEqual(Buffer.concat([Buffer.from(read), Buffer.from(rest)]), bytes);
  await client.reader.closeSnapshot(first.id);

  const other = "00000000-0000-4000-8000-000000000003";
  await client.writer.replace(`${other}.result.json`, bytes);
  const one = await client.reader.openSnapshot({ kind: "result", attemptId: attempt });
  await assert.rejects(client.reader.openSnapshot({ kind: "result", attemptId: other }));
  await client.reader.closeSnapshot(one.id);
  const absent = await client.reader.readJournal(); assert.equal(absent, null);
});

test("staging bounds reserve aggregate bytes/handles, expire, and cancel without a commit", async t => {
  const { host, stateDir } = await fixture(t, { hostLimits: { stageHandles: 2, stageBytes: 10, stageTtlMs: 50 } });
  const signal = () => new AbortController().signal;
  const a = await host.handle(writeBegin("attempts.jsonl", 8), signal());
  await assert.rejects(host.handle(writeBegin("attempts.jsonl", 3), signal()));
  await host.handle({ action: "write-cancel", id: a.id }, signal());
  const b = await host.handle(writeBegin("attempts.jsonl", 8), signal());
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(host.handle({ action: "write-chunk", id: b.id, offset: 0, bytes: "YWFhYWFhYWE=" }, signal()));
  await assert.rejects(host.handle({ action: "write-commit", id: b.id }, signal()));
  await assert.rejects(readFile(join(stateDir, "attempts.jsonl")));
});

test("aborted snapshot reads release host handles and client close cancels remaining snapshots", async t => {
  const { host, call, client } = await fixture(t, { hostLimits: { snapshotHandles: 1 } });
  await client.writer.replace(`${attempt}.result.json`, Buffer.from("result"));
  const info = await host.handle({ action: "snapshot-open", kind: "result", attemptId: attempt }, new AbortController().signal);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(host.handle({ action: "snapshot-read", id: info.id, offset: 0, length: 2 }, abort.signal));
  const again = await call({ action: "snapshot-open", kind: "result", attemptId: attempt });
  await call({ action: "snapshot-close", id: again.id });
  const pending = await client.reader.openSnapshot({ kind: "result", attemptId: attempt });
  await client.close();
  await assert.rejects(client.reader.readSnapshot(pending.id, 0, 1));
});

test("host close waits for active commit and retains staging reservation until commit finishes", async t => {
  const base = await mkdtemp(join(tmpdir(), "excess-win-state-close-")), stateDir = join(base, "state");
  await mkdir(stateDir, { mode: 0o700 }); if (process.platform === "linux") await chmod(stateDir, 0o700);
  const reader = await createWorkerStateReader({ stateDir });
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
  const writer = { replace: async () => { entered(); await releasePromise; }, appendJournal: async () => {}, removeOutput: async () => {}, markShutdownUnverified: async () => {} };
  const host = __testOnlyCreateWindowsStateHost(reader, writer, { limits: { stageBytes: 16 } });
  t.after(async () => { await host.close().catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const signal = () => new AbortController().signal;
  const begin = await host.handle(writeBegin("status.json", 12), signal());
  await host.handle({ action: "write-chunk", id: begin.id, offset: 0, bytes: Buffer.alloc(12, 0x61).toString("base64") }, signal());
  const commit = host.handle({ action: "write-commit", id: begin.id }, signal());
  await enteredPromise;
  await assert.rejects(host.handle(writeBegin("attempts.jsonl", 5), signal()));
  let closed = false; const closing = host.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release(); await Promise.allSettled([commit]); await closing; assert.equal(closed, true);
});

test("host close waits for an in-flight snapshot open and rejects the late handle", async t => {
  const base = await mkdtemp(join(tmpdir(), "excess-win-state-open-close-")), stateDir = join(base, "state");
  await mkdir(stateDir, { mode: 0o700 }); if (process.platform === "linux") await chmod(stateDir, 0o700);
  const store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {} });
  const reader = await createWorkerStateReader({ stateDir });
  await store.replace(`${attempt}.result.json`, Buffer.from("result"));
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
  const delayed = {
    readPolicy: () => reader.readPolicy(), readControl: () => reader.readControl(), readOffers: modelId => reader.readOffers(modelId),
    readAutoPrices: modelId => reader.readAutoPrices(modelId), readJournalOwner: () => reader.readJournalOwner(), readJournal: () => reader.readJournal(),
    readResult: id => reader.readResult(id), readArtifact: (id, hash) => reader.readArtifact(id, hash), listOutputs: id => reader.listOutputs(id),
    openSnapshot: async (...args) => { entered(); await releasePromise; return reader.openSnapshot(...args); },
    readSnapshot: (...args) => reader.readSnapshot(...args), closeSnapshot: id => reader.closeSnapshot(id), close: () => reader.close(),
  };
  const host = createWindowsStateHost(delayed, store);
  t.after(async () => { await host.close().catch(() => {}); await store.close(); await rm(base, { recursive: true, force: true }); });
  const opening = host.handle({ action: "snapshot-open", kind: "result", attemptId: attempt }, new AbortController().signal);
  await enteredPromise;
  let closed = false; const closing = host.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release();
  const result = await Promise.allSettled([opening]); await closing;
  assert.equal(result[0].status, "rejected"); assert.equal(closed, true);
});
