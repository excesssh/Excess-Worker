import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

/** Protocol for authenticated EXCESS worker release metadata. The manifest is signed as exact bytes. */
export const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
export const RELEASE_FILE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const RELEASE_FIELD_MAX_BYTES = 512;
export const RELEASE_REPOSITORY = "https://github.com/excesssh/Excess-Worker" as const;
export const RELEASE_PRODUCT = "Excess Worker" as const;
export const RELEASE_PLATFORMS = ["win32-x64", "linux-x64"] as const;

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const fieldText = z.string().min(1).max(RELEASE_FIELD_MAX_BYTES).refine(value =>
  Buffer.byteLength(value, "utf8") <= RELEASE_FIELD_MAX_BYTES && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const platformSchema = z.enum(RELEASE_PLATFORMS);
const fileSchema = z.strictObject({
  platform: platformSchema,
  file: z.string().min(1).max(160),
  bytes: z.number().int().positive().max(RELEASE_FILE_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reproducible: z.boolean(),
});
const manifestSchema = z.strictObject({
  format: z.literal(1),
  product: z.literal(RELEASE_PRODUCT),
  version: z.string().regex(semver),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  repository: z.literal(RELEASE_REPOSITORY),
  releasedAt: z.iso.datetime(),
  files: z.array(fileSchema).min(1).max(RELEASE_PLATFORMS.length),
  isolation: z.partialRecord(platformSchema, fieldText),
  permissions: z.strictObject({ filesystem: fieldText, network: fieldText, credentials: fieldText }),
}).superRefine((manifest, context) => {
  const platforms = manifest.files.map(item => item.platform);
  if (new Set(platforms).size !== platforms.length) context.addIssue({ code: "custom", path: ["files"], message: "duplicate release platform" });
  const suffix: Record<(typeof RELEASE_PLATFORMS)[number], string> = { "win32-x64": "win-x64.zip", "linux-x64": "linux-x64.tar.gz" };
  for (const [index, item] of manifest.files.entries()) {
    const expected = `excess-worker-${manifest.version}-${manifest.sourceCommit.slice(0, 12)}-${suffix[item.platform]}`;
    if (item.file !== expected) context.addIssue({ code: "custom", path: ["files", index, "file"], message: "release filename must bind version, source commit, and platform" });
  }
  const declared = Object.keys(manifest.isolation).sort();
  const present = [...platforms].sort();
  if (declared.length !== present.length || declared.some((platform, index) => platform !== present[index])) {
    context.addIssue({ code: "custom", path: ["isolation"], message: "isolation profiles must match the release platforms" });
  }
});

export type ReleaseManifest = z.infer<typeof manifestSchema>;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

function strictBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`Invalid Minisign ${label}`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`Invalid Minisign ${label}`);
  return decoded;
}

function lines(text: string, label: string, maxBytes: number, count: number): string[] {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes || Buffer.from(text, "utf8").toString("utf8") !== text ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw new Error(`Invalid Minisign ${label}`);
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const values = normalized.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (values.length !== count || values.some(line => line.includes("\r"))) throw new Error(`Invalid Minisign ${label}`);
  return values;
}

function minisignPublicKey(publicKeyText: string): { keyId: Buffer; key: ReturnType<typeof createPublicKey> } {
  const [comment, encoded] = lines(publicKeyText, "public key", 1024, 2);
  if (!comment!.startsWith("untrusted comment: ")) throw new Error("Invalid Minisign public key comment");
  const raw = strictBase64(encoded!, "public key");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("ascii") !== "Ed") throw new Error("Unsupported Minisign public key algorithm");
  const keyId = raw.subarray(2, 10), rawKey = raw.subarray(10);
  const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return { keyId, key: createPublicKey({ key: Buffer.concat([derPrefix, rawKey]), format: "der", type: "spki" }) };
}

/** Verify a modern Minisign ED (BLAKE2b-512 prehash) signature, including its signed trusted comment. */
export function verifyMinisign(bytes: Uint8Array, signatureText: string, publicKeyText: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RELEASE_FILE_MAX_BYTES) throw new Error("Invalid signed release bytes");
  const [untrusted, encodedSignature, trustedLine, encodedGlobal] = lines(signatureText, "signature", 10 * 1024, 4);
  if (!untrusted!.startsWith("untrusted comment: ") || !trustedLine!.startsWith("trusted comment: ")) throw new Error("Invalid Minisign comments");
  const trustedComment = trustedLine!.slice("trusted comment: ".length);
  if (!trustedComment || Buffer.byteLength(trustedComment, "utf8") > 8192) throw new Error("Invalid Minisign trusted comment");
  const payload = strictBase64(encodedSignature!, "signature");
  const globalSignature = strictBase64(encodedGlobal!, "global signature");
  if (payload.length !== 74 || globalSignature.length !== 64) throw new Error("Invalid Minisign signature length");
  if (payload.subarray(0, 2).toString("ascii") !== "ED") throw new Error("Legacy or unsupported Minisign signature algorithm");
  const pinned = minisignPublicKey(publicKeyText), keyId = payload.subarray(2, 10), signature = payload.subarray(10);
  if (!keyId.equals(pinned.keyId)) throw new Error("Minisign key ID mismatch");
  const prehash = createHash("blake2b512").update(bytes).digest();
  if (!verify(null, prehash, pinned.key, signature)) throw new Error("Minisign release signature verification failed");
  const signedComment = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!verify(null, signedComment, pinned.key, globalSignature)) throw new Error("Minisign trusted comment verification failed");
}

/** Decode and validate a bounded UTF-8 JSON manifest. The signature must be verified over these same exact bytes first. */
export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > RELEASE_MANIFEST_MAX_BYTES) throw new Error("Release manifest size is invalid");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("Release manifest is not valid UTF-8"); }
  if (text.charCodeAt(0) === 0xfeff) throw new Error("Release manifest must not contain a BOM");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Release manifest is not valid JSON"); }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid release manifest: ${result.error.issues[0]?.path.join(".") || "schema"}`);
  return result.data;
}

export interface ReleaseState { sequence: number; version: string; sourceCommit: string; manifestDigest?: string }

function compareSemver(left: string, right: string): number {
  const a = semver.exec(left), b = semver.exec(right);
  if (!a || !b) throw new Error("Invalid release version");
  for (let index = 1; index <= 3; index++) {
    const x = BigInt(a[index]!), y = BigInt(b[index]!);
    if (x !== y) return x < y ? -1 : 1;
  }
  const ap = a[4], bp = b[4];
  if (ap === undefined || bp === undefined) return ap === bp ? 0 : ap === undefined ? 1 : -1;
  const ai = ap.split("."), bi = bp.split(".");
  for (let index = 0; index < Math.min(ai.length, bi.length); index++) {
    const x = ai[index]!, y = bi[index]!;
    if (x === y) continue;
    const xn = /^(0|[1-9][0-9]*)$/.test(x), yn = /^(0|[1-9][0-9]*)$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

/** Reject sequence rollback, sequence equivocation, invalid state, and semantic-version downgrade. */
export function assertReleaseAdvance(manifest: ReleaseManifest, current?: ReleaseState | null, candidateManifestDigest?: string): void {
  if (!current) return;
  if (!Number.isSafeInteger(current.sequence) || current.sequence < 1 || !semver.test(current.version) || !/^[0-9a-f]{40}$/.test(current.sourceCommit) ||
      (current.manifestDigest !== undefined && !/^[0-9a-f]{64}$/.test(current.manifestDigest)) ||
      (candidateManifestDigest !== undefined && !/^[0-9a-f]{64}$/.test(candidateManifestDigest))) throw new Error("Current release state is invalid");
  if (manifest.sequence < current.sequence) throw new Error("Release sequence rollback rejected");
  if (manifest.sequence === current.sequence) {
    if (manifest.version !== current.version || manifest.sourceCommit !== current.sourceCommit) throw new Error("Release sequence equivocation rejected");
    if (current.manifestDigest !== undefined && candidateManifestDigest !== undefined && current.manifestDigest !== candidateManifestDigest) throw new Error("Release sequence equivocation rejected");
    return;
  }
  if (compareSemver(manifest.version, current.version) < 0) throw new Error("Release version downgrade rejected");
}
