import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPairing, createWorkerConnection, finishPairing, sendHeartbeat, writeIdentity } from "../apps/worker/dist/identity.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const id = "2cc4601a-916d-4c4d-a5a1-6728c2d71937";
const origin = "https://worker.example";

function signedKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { publicKey, privateKey, publicKeyObject: createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" }), privateKeyObject: pair.privateKey };
}

function verifySigned(body, publicKey) {
  assert.equal(typeof body.message, "string");
  assert.equal(verify(null, Buffer.from(body.message), publicKey, Buffer.from(body.signature, "base64")), true);
  return JSON.parse(body.message);
}

test("pairing, heartbeat, command and offer use the injected fetcher with signed bounded requests", async () => {
  const calls = [];
  const beginningFetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init.method, redirect: init.redirect, signal: init.signal });
    assert.equal(url.origin, origin); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
    if (url.pathname === "/v1/public-config") return json({ product: "EXCESS", chainId: 314 });
    assert.equal(url.pathname, "/v1/devices/pairing/start");
    assert.equal(init.method, "POST");
    const submitted = JSON.parse(init.body);
    const fingerprint = createHash("sha256").update(Buffer.from(submitted.publicKey, "base64")).digest("hex");
    const pairingId = "f7db08f2-09c3-4c67-83b3-eebd3f04c141";
    const expiresAt = new Date(Date.now() + 120000).toISOString();
    const challenge = { protocol: "EXCESS_DEVICE_PAIR_V1", origin, chainId: 314, pairingId, fingerprint,
      expiresAt, nonce: "N".repeat(43) };
    return json({ pairingId, challenge: JSON.stringify(challenge), fingerprint, code: "FIXTURE1", expiresAt });
  };
  const pending = await beginPairing(origin, "TEST ONLY", beginningFetcher);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/v1/public-config", "/v1/devices/pairing/start"]);

  const scratch = await mkdtemp(join(tmpdir(), "excess-identity-egress-"));
  try {
    const path = join(scratch, "identity.json");
    const pair = signedKeyPair();
    const identity = { version: 1, origin, chainId: 314, publicKey: pair.publicKey, privateKey: pair.privateKey,
      protection: "file-mode-0600", pairingId: "f7db08f2-09c3-4c67-83b3-eebd3f04c141", challenge: "signed pairing challenge fixture", sequence: 0 };
    await writeIdentity(path, identity);
    let oversized = false, cancelled = false;
    const fetcher = async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url: url.href, method: init.method, redirect: init.redirect, signal: init.signal });
      assert.equal(url.origin, origin); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      if (url.pathname === "/v1/devices/pairing/complete") {
        assert.equal(body.pairingId, identity.pairingId);
        assert.equal(verify(null, Buffer.from(identity.challenge), pair.publicKeyObject, Buffer.from(body.signature, "base64")), true);
        return json({ deviceId: id });
      }
      const message = verifySigned(body, pair.publicKeyObject);
      if (url.pathname === "/v1/worker/heartbeat") {
        assert.equal(message.type, "worker.heartbeat");
        return json({ accepted: true, sequence: message.data.sequence });
      }
      if (url.pathname === "/v1/worker/command") {
        assert.equal(message.type, "worker.poll");
        if (oversized) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(1048577)); },
          cancel() { cancelled = true; throw new Error("cancel failure fixture"); },
        }), { status: 200, headers: { "content-type": "application/json" } });
        return json({ assignments: [] });
      }
      if (url.pathname === "/v1/worker/offer") {
        assert.equal(message.type, "worker.offer"); return json({ accepted: true });
      }
      assert.fail(`Unexpected injected request path: ${url.pathname}`);
    };

    assert.deepEqual(await finishPairing(path, fetcher), { deviceId: id });
    assert.deepEqual(await sendHeartbeat(path, undefined, fetcher), { accepted: true, sequence: 1 });
    const connection = await createWorkerConnection(path, fetcher);
    assert.equal(connection.origin, origin); assert.equal(connection.deviceId, id);
    assert.equal((await connection.heartbeat({ availableSlots: 0, capabilityDigests: [] })).sequence, 2);
    assert.deepEqual(await connection.command("worker.poll", {}), { assignments: [] });
    assert.deepEqual(await connection.offer({ capabilityDigest: "a".repeat(64), assetId: id, netUnits: "1", slots: 1, probedAt: new Date().toISOString() }), { accepted: true });
    assert.equal(JSON.parse(await readFile(path, "utf8")).sequence, 2);

    oversized = true;
    await assert.rejects(connection.command("worker.poll", {}), /Coordinator response too large/);
    assert.equal(cancelled, true, "oversized response stream is cancelled at the existing 1 MiB cap even when disposal fails");
    assert.equal(calls.every(call => call.redirect === "error"), true);
    assert.equal(calls.every(call => new URL(call.url).origin === origin), true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("the injected fetcher receives only the paired origin and fixed worker command route", async () => {
  const pair = signedKeyPair(), scratch = await mkdtemp(join(tmpdir(), "excess-identity-origin-"));
  const path = join(scratch, "identity.json");
  try {
    await writeIdentity(path, { version: 1, origin, chainId: 1, publicKey: pair.publicKey, privateKey: pair.privateKey,
      protection: "file-mode-0600", pairingId: id, challenge: "fixture", deviceId: id, sequence: 0 });
    const seen = [];
    const fetcher = async (input, init) => {
      const url = new URL(input); seen.push(url.href);
      assert.equal(url.origin, origin); assert.equal(url.pathname, "/v1/worker/command");
      assert.equal(init.redirect, "error"); return json({});
    };
    const connection = await createWorkerConnection(path, fetcher);
    await connection.command("worker.poll", {});
    assert.equal(seen.length, 1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
