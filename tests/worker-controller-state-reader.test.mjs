import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID, MODEL_CATALOG } from "@excess/adapters";
import { DEFAULT_WORKER_POLICY } from "../apps/worker/dist/policy.js";
import { __testOnlyContainsBlockedChunks, __testOnlyCreateWorkerStateReader, createWorkerStateReader } from "../apps/worker/dist/controller-state-reader.js";

const attempt = "00000000-0000-4000-8000-000000000001";
const asset = "00000000-0000-4000-8000-000000000002";
const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "excess-state-reader-"));
  const stateDir = join(base, "state");
  await mkdir(stateDir, { mode: 0o700 });
  if (process.platform === "linux") await chmod(stateDir, 0o700);
  const reader = await createWorkerStateReader({ stateDir });
  t.after(async () => { await reader.close(); await rm(base, { recursive: true, force: true }); });
  return { base, stateDir, reader };
}
async function put(stateDir, name, value) {
  const path = join(stateDir, ...name.split("/"));
  if (name.includes("/")) {
    await mkdir(join(stateDir, name.split("/")[0]), { recursive: true, mode: 0o700 });
    if (process.platform === "linux") await chmod(join(stateDir, name.split("/")[0]), 0o700);
  }
  await writeFile(path, value, { mode: 0o600 });
  if (process.platform === "linux") await chmod(path, 0o600);
  return path;
}

test("missing policy/control/offers/prices/journal use existing defaults", async t => {
  const { reader } = await fixture(t);
  assert.deepEqual(await reader.readPolicy(), { ...DEFAULT_WORKER_POLICY });
  assert.equal(await reader.readControl(), "stop");
  assert.deepEqual(await reader.readOffers(), []);
  assert.deepEqual(await reader.readAutoPrices(), new Map());
  assert.equal(await reader.readJournalOwner(), null);
  assert.equal(await reader.readJournal(), null);
});

test("valid policy, control, catalog offers and auto prices retain existing parsing semantics", async t => {
  const { stateDir, reader } = await fixture(t);
  const policy = { ...DEFAULT_WORKER_POLICY, threads: 3, model: DEFAULT_MODEL_ID };
  await put(stateDir, "policy.json", JSON.stringify(policy));
  await put(stateDir, "control.json", JSON.stringify({ version: 1, mode: "drain" }));
  await put(stateDir, `offers/${DEFAULT_MODEL_ID}.json`, JSON.stringify({ offers: [{ assetId: asset, netUnits: "1.25" }] }));
  await put(stateDir, `offers/${DEFAULT_MODEL_ID}.auto.json`, JSON.stringify({ prices: { [asset]: "2.5" } }));
  const owner = Buffer.from('{"version":1,"deviceId":"device-safe"}');
  const journal = Buffer.from('{"state":"seen"}\n');
  await put(stateDir, "journal-owner.json", owner);
  await put(stateDir, "attempts.jsonl", journal);
  assert.equal((await reader.readPolicy()).threads, 3);
  assert.equal(await reader.readControl(), "drain");
  assert.deepEqual(await reader.readOffers(), [{ assetId: asset, netUnits: "1.25" }]);
  assert.deepEqual(await reader.readAutoPrices(), new Map([[asset, "2.5"]]));
  assert.deepEqual(await reader.readJournalOwner(), owner);
  assert.deepEqual(await reader.readJournal(), journal);
  assert.ok(MODEL_CATALOG.some(entry => entry.id === DEFAULT_MODEL_ID));
});

test("reader refuses schema errors, traversal, unknown models, and oversized state before parsing", async t => {
  const { stateDir, reader } = await fixture(t);
  await put(stateDir, "policy.json", JSON.stringify({ unexpected: "x" }));
  await assert.rejects(reader.readPolicy(), /WORKER_POLICY_INVALID/);
  await rm(join(stateDir, "policy.json"));
  await put(stateDir, "policy.json", Buffer.alloc(4097, 0x20));
  await assert.rejects(reader.readPolicy(), /WORKER_STATE_FILE_TOO_LARGE/);
  await assert.rejects(reader.readOffers("../identity"), /WORKER_STATE_MODEL_INVALID/);
  await assert.rejects(reader.readResult("../identity"), /WORKER_ATTEMPT_ID_INVALID/);
  await assert.rejects(reader.readArtifact(attempt, "../digest"), /WORKER_OUTPUT_ID_INVALID/);
  await assert.rejects(reader.openSnapshot({ kind: "result", attemptId: "../x" }), /WORKER_SNAPSHOT_REQUEST_INVALID/);
  await assert.rejects(reader.openSnapshot({ kind: "journal", path: "identity.json" }), /WORKER_SNAPSHOT_REQUEST_INVALID/);
});

test("read-only output access returns exact bounded bytes and only exact attempt outputs", async t => {
  const { stateDir, reader } = await fixture(t);
  const result = Buffer.from('{"kind":"text","text":"safe"}');
  const artifact = Buffer.from("artifact bytes");
  await put(stateDir, `${attempt}.result.json`, result);
  await put(stateDir, `${attempt}.artifact.${sha}.bin`, artifact);
  await put(stateDir, "00000000-0000-4000-8000-000000000003.result.json", Buffer.from("other attempt"));
  assert.deepEqual(await reader.readResult(attempt), result);
  assert.deepEqual(await reader.readArtifact(attempt, sha), artifact);
  assert.deepEqual(await reader.listOutputs(attempt), [`${attempt}.artifact.${sha}.bin`, `${attempt}.result.json`]);
});

test("reader rejects symlink roots, offer anchors and result files", async t => {
  const { base, stateDir, reader } = await fixture(t);
  const rootLink = join(base, "state-link");
  try { await symlink(stateDir, rootLink, "dir"); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(createWorkerStateReader({ stateDir: rootLink }), /WORKER_STATE_LINK_REFUSED/);
  await rm(rootLink);
  const target = await put(stateDir, "status.json", Buffer.from("safe"));
  const link = join(stateDir, `${attempt}.result.json`);
  try { await symlink(target, link); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(reader.readResult(attempt), /WORKER_STATE_LINK_REFUSED|WORKER_STATE_FILE_REFUSED/);
  await rm(link);
  const offerDir = join(stateDir, "offers"), outside = join(base, "outside");
  await mkdir(outside, { mode: 0o700 });
  try { await symlink(outside, offerDir, "dir"); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(reader.readOffers(), /WORKER_STATE_LINK_REFUSED|WORKER_STATE_DIRECTORY_REFUSED/);
});

test("reader rejects output names hard-linked to another host state file", async t => {
  const { stateDir, reader } = await fixture(t);
  const source = await put(stateDir, "identity.json", Buffer.from('{"origin":"https://coordinator.example"}'));
  const target = join(stateDir, `${attempt}.result.json`);
  try { await link(source, target); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("hard-link creation unavailable"); return; } throw error; }
  await assert.rejects(reader.readResult(attempt), /WORKER_STATE_FILE_REFUSED/);
});

test("chunk snapshot reports stable SHA-256, requires sequential bounded offsets, and expires", async t => {
  const { stateDir, reader } = await fixture(t);
  const bytes = Buffer.from("0123456789abcdefghij");
  await put(stateDir, "attempts.jsonl", bytes);
  const snapshot = await reader.openSnapshot({ kind: "journal" });
  assert.equal(snapshot.size, bytes.length);
  assert.equal(snapshot.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(snapshot.chunkBytes, 64 * 1024);
  await assert.rejects(reader.readSnapshot(snapshot.id, 1, 4), /WORKER_SNAPSHOT_OFFSET_INVALID/);
  await assert.rejects(reader.readSnapshot(snapshot.id, 0, 64 * 1024 + 1), /WORKER_SNAPSHOT_REQUEST_INVALID/);
  const first = await reader.readSnapshot(snapshot.id, 0, 7);
  const second = await reader.readSnapshot(snapshot.id, 7, bytes.length - 7);
  assert.deepEqual(Buffer.concat([first, second]), bytes);
  await reader.closeSnapshot(snapshot.id);
  await assert.rejects(reader.readSnapshot(snapshot.id, 0, 1), /WORKER_SNAPSHOT_NOT_FOUND/);

  const cancelled = await reader.openSnapshot({ kind: "journal" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(reader.readSnapshot(cancelled.id, 0, 1, abort.signal), /WORKER_SNAPSHOT_ABORTED/);
  await assert.rejects(reader.readSnapshot(cancelled.id, 0, 1), /WORKER_SNAPSHOT_NOT_FOUND/);

  const onClose = await reader.openSnapshot({ kind: "journal" });
  await reader.close();
  await assert.rejects(reader.readSnapshot(onClose.id, 0, 1), /WORKER_STATE_READER_CLOSED/);

  const expiring = await __testOnlyCreateWorkerStateReader({ stateDir, limits: { ttlMs: 50 } });
  t.after(() => expiring.close());
  const handle = await expiring.openSnapshot({ kind: "journal" });
  await new Promise(resolve => setTimeout(resolve, 75));
  await assert.rejects(expiring.readSnapshot(handle.id, 0, 1), /WORKER_SNAPSHOT_EXPIRED|WORKER_SNAPSHOT_NOT_FOUND/);
});

test("snapshots bound handles and aggregate bytes and detect in-place mutation", async t => {
  const { stateDir } = await fixture(t);
  const firstPath = await put(stateDir, `${attempt}.result.json`, Buffer.from("12345"));
  const secondId = "00000000-0000-4000-8000-000000000004";
  await put(stateDir, `${secondId}.result.json`, Buffer.from("1234"));
  const reader = await __testOnlyCreateWorkerStateReader({ stateDir, limits: { maxHandles: 4, maxBytes: 6 } });
  t.after(() => reader.close());
  const opened = await reader.openSnapshot({ kind: "result", attemptId: attempt });
  await assert.rejects(reader.openSnapshot({ kind: "result", attemptId: secondId }), /WORKER_SNAPSHOT_LIMIT/);
  await reader.closeSnapshot(opened.id);
  const second = await reader.openSnapshot({ kind: "result", attemptId: secondId });
  await reader.closeSnapshot(second.id);
  const handleLimited = await __testOnlyCreateWorkerStateReader({ stateDir, limits: { maxHandles: 1, maxBytes: 8 } });
  t.after(() => handleLimited.close());
  const raced = await Promise.allSettled([handleLimited.openSnapshot({ kind: "result", attemptId: attempt }), handleLimited.openSnapshot({ kind: "result", attemptId: secondId })]);
  assert.equal(raced.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(raced.filter(item => item.status === "rejected").length, 1);
  assert.match(raced.find(item => item.status === "rejected").reason.message, /WORKER_SNAPSHOT_LIMIT/);
  const one = raced.find(item => item.status === "fulfilled").value;
  await handleLimited.closeSnapshot(one.id);

  const ordinary = await createWorkerStateReader({ stateDir });
  t.after(() => ordinary.close());
  const mutable = await ordinary.openSnapshot({ kind: "result", attemptId: attempt });
  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(firstPath, Buffer.from("abcde"));
  await assert.rejects(ordinary.readSnapshot(mutable.id, 0, 5), /WORKER_STATE_FILE_CHANGED/);
});

test("close waits for an opening snapshot hash and closes its unregistered file", async t => {
  const { stateDir } = await fixture(t);
  await put(stateDir, "attempts.jsonl", Buffer.alloc(512 * 1024, 0x61));
  let reached;
  const reachedPromise = new Promise(resolve => { reached = resolve; });
  let release;
  const releasePromise = new Promise(resolve => { release = resolve; });
  let paused = false;
  const reader = await __testOnlyCreateWorkerStateReader({ stateDir, limits: {}, hooks: { afterHashChunk: async () => {
    if (paused) return;
    paused = true; reached(); await releasePromise;
  } } });
  const opening = reader.openSnapshot({ kind: "journal" });
  await reachedPromise;
  const closingA = reader.close(), closingB = reader.close();
  release();
  const [openResult] = await Promise.allSettled([opening, closingA, closingB]);
  await Promise.all([closingA, closingB]);
  assert.equal(openResult.status, "rejected");
  assert.match(openResult.reason.message, /WORKER_STATE_READER_CLOSED/);
  await assert.rejects(reader.readJournal(), /WORKER_STATE_READER_CLOSED/);
});

test("concurrent close during a snapshot read cancels the read and drains both closes", async t => {
  const { stateDir } = await fixture(t);
  await put(stateDir, "attempts.jsonl", Buffer.alloc(64 * 1024, 0x62));
  let reached;
  const reachedPromise = new Promise(resolve => { reached = resolve; });
  let release;
  const releasePromise = new Promise(resolve => { release = resolve; });
  const reader = await __testOnlyCreateWorkerStateReader({ stateDir, limits: {}, hooks: { afterReadChunk: async () => {
    reached(); await releasePromise;
  } } });
  const snapshot = await reader.openSnapshot({ kind: "journal" });
  const reading = reader.readSnapshot(snapshot.id, 0, 64 * 1024);
  await reachedPromise;
  const closingA = reader.close(), closingB = reader.close(), snapshotClose = reader.closeSnapshot(snapshot.id);
  release();
  const readResult = await Promise.allSettled([reading]);
  await Promise.all([closingA, closingB, snapshotClose]);
  assert.equal(readResult[0].status, "rejected");
  assert.match(readResult[0].reason.message, /WORKER_STATE_READER_CLOSED/);
  await assert.rejects(reader.readJournal(), /WORKER_STATE_READER_CLOSED/);
});

test("blocked identifier screening handles case, wide bytes and chunk boundaries in memory only", () => {
  const marker = Buffer.from(["A", "a", "R", "o", "N"].join(""), "ascii");
  const bytesLe = Buffer.alloc(marker.length * 2), bytesBe = Buffer.alloc(marker.length * 2);
  for (let index = 0; index < marker.length; index++) { bytesLe[index * 2] = marker[index]; bytesBe[index * 2 + 1] = marker[index]; }
  assert.equal(__testOnlyContainsBlockedChunks([Buffer.from("prefix"), marker.subarray(0, 2), marker.subarray(2), Buffer.from("suffix")]), true);
  assert.equal(__testOnlyContainsBlockedChunks([bytesLe.subarray(0, 3), bytesLe.subarray(3)]), true);
  assert.equal(__testOnlyContainsBlockedChunks([bytesBe.subarray(0, 7), bytesBe.subarray(7)]), true);
  assert.equal(__testOnlyContainsBlockedChunks([Buffer.from("ordinary journal text")]), false);
});
