import { createHash } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_WORKER_MESSAGE_BYTES = 65536;
export const MAX_BASE_UNITS = (1n << 256n) - 1n;
export const baseUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) <= MAX_BASE_UNITS);
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .refine(value => value.toLowerCase() !== "0x0000000000000000000000000000000000000000")
  .transform(value => value.toLowerCase());
export const assetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), kind: z.literal("native") }),
  z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), kind: z.literal("erc20"), address: addressSchema }),
]);
export type Asset = z.infer<typeof assetSchema>;
export function assetKey(input: Asset): string {
  const asset = assetSchema.parse(input);
  return `${asset.chainId}:${asset.kind === "native" ? "native" : asset.address}`;
}

export function quoteCharge(net: bigint, feeBps: number): { net: bigint; gross: bigint; fee: bigint } {
  if (typeof net !== "bigint" || net < 0n || net > MAX_BASE_UNITS) throw new RangeError("Invalid net base units");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) throw new RangeError("Fee must be 0..9999 basis points");
  const denominator = 10000n - BigInt(feeBps);
  const gross = (net * 10000n + denominator - 1n) / denominator;
  if (gross > MAX_BASE_UNITS) throw new RangeError("Gross charge exceeds supported base units");
  return { net, gross, fee: gross - net };
}

export const jobStateSchema = z.enum(["quoted", "reserved", "queued", "leased", "running", "verifying", "succeeded", "failed", "cancelled", "expired"]);
export type JobState = z.infer<typeof jobStateSchema>;
const transitions: Record<JobState, readonly JobState[]> = {
  quoted: ["reserved", "expired", "cancelled"],
  reserved: ["queued", "expired", "cancelled"],
  queued: ["leased", "expired", "cancelled", "failed"],
  leased: ["running", "queued", "failed", "cancelled"],
  running: ["verifying", "queued", "failed", "cancelled"],
  verifying: ["succeeded", "failed"],
  succeeded: [], failed: [], cancelled: [], expired: [],
};
export function assertJobTransition(from: JobState, to: JobState, deliveredUnits = 0n): void {
  jobStateSchema.parse(from); jobStateSchema.parse(to);
  if (deliveredUnits < 0n) throw new RangeError("Negative delivery cursor");
  if (!transitions[from].includes(to)) throw new Error("Invalid job transition");
  if (to === "queued" && deliveredUnits > 0n) throw new Error("A streamed attempt cannot be retried");
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = {
  version: z.literal(PROTOCOL_VERSION),
  messageId: z.uuid(),
  correlationId: z.uuid(),
  sentAt: z.iso.datetime(),
};
export const workerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope, type: z.literal("worker.heartbeat"),
    data: z.strictObject({
      deviceId: z.uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      availableSlots: z.number().int().min(0).max(32),
      capabilityDigests: z.array(digestSchema).max(128),
    }),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.result"),
    data: z.strictObject({
      deviceId: z.uuid(), jobId: z.uuid(), attemptId: z.uuid(),
      fence: baseUnitsSchema.refine(value => BigInt(value) > 0n),
      outputDigest: digestSchema,
      // A worker declaration is not authoritative billing or delivery evidence.
      reportedUnits: baseUnitsSchema,
    }),
  }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export class ProtocolError extends Error {
  constructor(public readonly code: "MESSAGE_TOO_LARGE" | "INVALID_MESSAGE") { super(code); this.name = "ProtocolError"; }
}
export function parseWorkerMessage(raw: Uint8Array | string): WorkerMessage {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > MAX_WORKER_MESSAGE_BYTES) throw new ProtocolError("MESSAGE_TOO_LARGE");
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return workerMessageSchema.parse(JSON.parse(text));
  } catch { throw new ProtocolError("INVALID_MESSAGE"); }
}

// EXCESS JSON canonicalization v1: sorted object keys, ordered arrays, finite safe
// integer numbers, no undefined values. Monetary amounts travel as decimal strings.
export function requestDigest(value: unknown): string {
  function canonical(input: unknown, depth: number): string {
    if (depth > 32) throw new RangeError("Request nesting exceeds limit");
    if (input === null || typeof input === "boolean" || typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number" && Number.isSafeInteger(input)) return JSON.stringify(input);
    if (Array.isArray(input)) {
      for (let i = 0; i < input.length; i++) if (!(i in input)) throw new TypeError("Sparse arrays are unsupported");
      return "[" + input.map(item => canonical(item, depth + 1)).join(",") + "]";
    }
    if (typeof input === "object" && input && Object.getPrototypeOf(input) === Object.prototype) {
      return "{" + Object.keys(input).sort().map(key => JSON.stringify(key) + ":" + canonical((input as Record<string, unknown>)[key], depth + 1)).join(",") + "}";
    }
    throw new TypeError("Unsupported canonical request value");
  }
  const text = canonical(value, 0);
  if (Buffer.byteLength(text, "utf8") > MAX_WORKER_MESSAGE_BYTES) throw new RangeError("Request exceeds limit");
  return createHash("sha256").update("excess:request:v1\n").update(text).digest("hex");
}
