import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { quoteCharge, MAX_BASE_UNITS, assetKey, parseWorkerMessage, requestDigest, assertJobTransition } from "../packages/protocol/dist/index.js";

test("cumulative fee arithmetic conserves base units and rounds up exactly", () => {
  for (const feeBps of [0, 1, 500, 1000, 9999]) {
    for (let net = 0n; net < 1000n; net += 7n) {
      const charge = quoteCharge(net, feeBps);
      assert.equal(charge.gross, charge.net + charge.fee);
      assert.ok(charge.gross * BigInt(10000 - feeBps) >= net * 10000n);
      if (net > 0n) assert.ok((charge.gross - 1n) * BigInt(10000 - feeBps) < net * 10000n);
    }
  }
  assert.deepEqual(quoteCharge(9000000n, 1000), { net: 9000000n, gross: 10000000n, fee: 1000000n });
  assert.equal(quoteCharge(900719925474099312345n, 0).gross, 900719925474099312345n);
});
test("invalid fees, overflow and floating money are rejected", () => {
  for (const fee of [-1, 0.1, 10000, Infinity, NaN]) assert.throws(() => quoteCharge(1n, fee));
  for (const net of [-1n, MAX_BASE_UNITS + 1n, 1.5]) assert.throws(() => quoteCharge(net, 0));
  assert.throws(() => quoteCharge(MAX_BASE_UNITS, 1));
});
test("asset identity separates chain/native/token and normalizes addresses", () => {
  assert.equal(assetKey({ chainId: 4663, kind: "native" }), "4663:native");
  assert.equal(assetKey({ chainId: 4663, kind: "erc20", address: "0x" + "AB".repeat(20) }), "4663:0x" + "ab".repeat(20));
  assert.notEqual(assetKey({ chainId: 4663, kind: "native" }), assetKey({ chainId: 46630, kind: "native" }));
  assert.throws(() => assetKey({ chainId: 4663, kind: "native", address: "0x" + "ab".repeat(20) }));
  assert.throws(() => assetKey({ chainId: 4663, kind: "erc20", address: "0x" + "0".repeat(40) }));
});
test("worker messages are versioned, bounded and strict before ingestion", () => {
  const message = { version: 1, messageId: randomUUID(), correlationId: randomUUID(), sentAt: new Date().toISOString(), type: "worker.heartbeat", data: { deviceId: randomUUID(), sequence: 1, availableSlots: 1, capabilityDigests: [] } };
  assert.deepEqual(parseWorkerMessage(JSON.stringify(message)), message);
  for (const invalid of [{ ...message, version: 2 }, { ...message, secret: "oops" }, { ...message, data: { ...message.data, availableSlots: 100 } }]) {
    assert.throws(() => parseWorkerMessage(JSON.stringify(invalid)), { code: "INVALID_MESSAGE" });
  }
  assert.throws(() => parseWorkerMessage("x".repeat(65537)), { code: "MESSAGE_TOO_LARGE" });
  assert.throws(() => parseWorkerMessage(Uint8Array.from([0xff])), { code: "INVALID_MESSAGE" });
});
test("request digest is stable for key order and changes with meaningful input", () => {
  assert.equal(requestDigest({ a: 1, b: ["x", 2] }), requestDigest({ b: ["x", 2], a: 1 }));
  assert.notEqual(requestDigest({ a: 1 }), requestDigest({ a: 2 }));
  for (const input of [{ x: undefined }, { x: NaN }, { x: 1.5 }, new Date(), [,,]]) assert.throws(() => requestDigest(input));
});
test("state transitions prevent terminal resurrection and retry after delivered output", () => {
  assertJobTransition("leased", "queued", 0n);
  assert.throws(() => assertJobTransition("running", "queued", 0n));
  assert.throws(() => assertJobTransition("leased", "queued", 1n));
  assert.throws(() => assertJobTransition("running", "queued", 1n));
  assert.throws(() => assertJobTransition("succeeded", "queued"));
  assert.throws(() => assertJobTransition("queued", "succeeded"));
});
