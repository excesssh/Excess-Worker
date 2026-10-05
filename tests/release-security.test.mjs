import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { assertReleaseAdvance, parseReleaseManifest, verifyMinisign } from "../packages/protocol/dist/release.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const manifestValue = overrides => ({
  format: 1,
  product: "Excess Worker",
  version: "1.2.3",
  sequence: 7,
  sourceCommit: commit,
  repository: "https://github.com/excesssh/Excess-Worker",
  releasedAt: "2026-10-05T12:00:00Z",
  files: [
    { platform: "win32-x64", file: `excess-worker-1.2.3-${commit.slice(0, 12)}-win-x64.zip`, bytes: 1000, sha256: "a".repeat(64), reproducible: true },
    { platform: "linux-x64", file: `excess-worker-1.2.3-${commit.slice(0, 12)}-linux-x64.tar.gz`, bytes: 2000, sha256: "b".repeat(64), reproducible: false },
  ],
  isolation: { "win32-x64": "windows-appcontainer-job-v1", "linux-x64": "systemd-landlock-v1" },
  permissions: { filesystem: "read pinned runtime and model; write private scratch", network: "loopback worker RPC only", credentials: "attempt-scoped runtime API key" },
  ...overrides,
});

function minisignFixture(message, keyPair = generateKeyPairSync("ed25519"), keyId = Buffer.from("0123456789abcdef", "hex"), trusted = "sequence:7") {
  const publicDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  const publicRaw = publicDer.subarray(-32);
  const publicKey = `untrusted comment: fixture public key\n${Buffer.concat([Buffer.from("Ed"), keyId, publicRaw]).toString("base64")}\n`;
  const prehash = createHash("blake2b512").update(message).digest();
  const signature = sign(null, prehash, keyPair.privateKey);
  const payload = Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64");
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), keyPair.privateKey).toString("base64");
  const signatureText = `untrusted comment: fixture signature\n${payload}\ntrusted comment: ${trusted}\n${global}\n`;
  return { keyPair, keyId, publicKey, signatureText, signature, trusted };
}

test("Minisign modern ED verifies content and the global trusted-comment signature", () => {
  const bytes = Buffer.from(JSON.stringify(manifestValue()));
  const fixture = minisignFixture(bytes);
  assert.doesNotThrow(() => verifyMinisign(bytes, fixture.signatureText, fixture.publicKey));
  assert.throws(() => verifyMinisign(Buffer.concat([bytes, Buffer.from(" ")]), fixture.signatureText, fixture.publicKey), /signature verification failed/);
  assert.throws(() => verifyMinisign(bytes, fixture.signatureText.replace("sequence:7", "sequence:8"), fixture.publicKey), /trusted comment verification failed/);
});

test("Minisign rejects legacy, malformed text, wrong key ID, and a different key", () => {
  const bytes = Buffer.from("release fixture");
  const fixture = minisignFixture(bytes);
  const legacyPayload = Buffer.concat([Buffer.from("Ed"), fixture.keyId, fixture.signature]).toString("base64");
  const legacy = fixture.signatureText.replace(/^([^\n]*\n)[^\n]+/, `$1${legacyPayload}`);
  assert.throws(() => verifyMinisign(bytes, legacy, fixture.publicKey), /Legacy/);
  assert.throws(() => verifyMinisign(bytes, fixture.signatureText + "extra\n", fixture.publicKey), /signature/);
  const mismatchedId = minisignFixture(bytes, fixture.keyPair, Buffer.from("fedcba9876543210", "hex"));
  assert.throws(() => verifyMinisign(bytes, fixture.signatureText, mismatchedId.publicKey), /key ID mismatch/);
  const other = minisignFixture(bytes);
  assert.throws(() => verifyMinisign(bytes, fixture.signatureText, other.publicKey), /signature verification failed/);
  assert.throws(() => verifyMinisign(bytes, fixture.signatureText + " ".repeat(10 * 1024), fixture.publicKey), /signature/);
});

test("release manifest parser enforces the exact schema and source-bound archive names", () => {
  const bytes = Buffer.from(JSON.stringify(manifestValue()));
  assert.deepEqual(parseReleaseManifest(bytes), manifestValue());
  const onePlatform = manifestValue({ files: [manifestValue().files[0]], isolation: { "win32-x64": "windows-appcontainer-job-v1" } });
  assert.deepEqual(parseReleaseManifest(Buffer.from(JSON.stringify(onePlatform))), onePlatform);
  for (const value of [
    manifestValue({ unexpected: true }),
    manifestValue({ version: "01.2.3" }),
    manifestValue({ sequence: 0 }),
    manifestValue({ repository: "https://example.invalid/repo" }),
    manifestValue({ files: [{ ...manifestValue().files[0], file: "worker.zip" }] }),
    manifestValue({ files: [manifestValue().files[0], manifestValue().files[0]] }),
    manifestValue({ isolation: { "win32-x64": "windows-appcontainer-job-v1" } }),
    manifestValue({ permissions: { filesystem: "", network: "loopback only", credentials: "scoped" } }),
    manifestValue({ permissions: { filesystem: "f".repeat(513), network: "loopback only", credentials: "scoped" } }),
    manifestValue({ files: [{ ...manifestValue().files[0], bytes: 8 * 1024 * 1024 * 1024 + 1 }, manifestValue().files[1]] }),
  ]) assert.throws(() => parseReleaseManifest(Buffer.from(JSON.stringify(value))), /Invalid release manifest/);
  assert.throws(() => parseReleaseManifest(Buffer.from([0xff, 0xfe])), /UTF-8/);
  assert.throws(() => parseReleaseManifest(Buffer.from(" ".repeat(64 * 1024 + 1))), /size/);
});

test("release advance rejects rollback and equivocation while allowing an idempotent current release", () => {
  const base = parseReleaseManifest(Buffer.from(JSON.stringify(manifestValue())));
  const current = { sequence: 7, version: "1.2.3", sourceCommit: commit };
  assert.doesNotThrow(() => assertReleaseAdvance(base, current));
  assert.throws(() => assertReleaseAdvance({ ...base, sequence: 6 }, current), /sequence rollback/);
  assert.throws(() => assertReleaseAdvance({ ...base, sourceCommit: "f".repeat(40) }, current), /equivocation/);
  assert.throws(() => assertReleaseAdvance({ ...base, version: "1.2.4" }, current), /equivocation/);
  assert.throws(() => assertReleaseAdvance(base, { ...current, manifestDigest: "a".repeat(64) }, "b".repeat(64)), /equivocation/);
  assert.throws(() => assertReleaseAdvance(base, { ...current, manifestDigest: "a".repeat(64) }, "b".repeat(64)), /equivocation/);
  assert.throws(() => assertReleaseAdvance({ ...base, sequence: 8, version: "1.2.2" }, current), /version downgrade/);
  assert.doesNotThrow(() => assertReleaseAdvance({ ...base, sequence: 8, version: "1.2.4" }, current));
  assert.doesNotThrow(() => assertReleaseAdvance({ ...base, sequence: 8, version: "1.2.3" }, current));
  assert.throws(() => assertReleaseAdvance(base, { ...current, sequence: 0 }), /state is invalid/);
  for (const [candidate, previous] of [
    ["1.2.3-alpha", "1.2.3"],
    ["1.2.3-alpha.2", "1.2.3-alpha.10"],
    ["1.2.9", "1.3.0"],
    ["1.9.9", "2.0.0"],
  ]) assert.throws(() => assertReleaseAdvance({ ...base, sequence: 8, version: candidate }, { ...current, version: previous }), /version downgrade/);
  for (const [candidate, previous] of [
    ["1.2.3", "1.2.3-alpha.10"],
    ["1.2.3-alpha.11", "1.2.3-alpha.2"],
    ["1.3.0", "1.2.9"],
    ["2.0.0", "1.9.9"],
  ]) assert.doesNotThrow(() => assertReleaseAdvance({ ...base, sequence: 8, version: candidate }, { ...current, version: previous }));
});
