import { createHash } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
/** Owner-approved text job limits. Every layer reads these instead of literals. */
export const TEXT_LIMITS = Object.freeze({
  maxPromptBytes: 16384, maxOutputTokens: 2048, maxOutputBytes: 65536, maxStreamChunks: 2048,
  maxChunkTokens: 128, maxChunkBytes: 8192, maxRunSeconds: 600,
} as const);
// A signed job.result carries the whole output. JSON escaping can expand each
// output byte up to six times (\u00XX), so 6 * 65,536 bytes plus the envelope.
export const MAX_WORKER_MESSAGE_BYTES = 524288;
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
  // Once the worker acknowledges start, retry needs explicit future recovery
  // semantics; acknowledgement loss must not duplicate an execution.
  running: ["verifying", "failed", "cancelled"],
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
const attemptIdentity = {
  deviceId: z.uuid(), jobId: z.uuid(), attemptId: z.uuid(),
  // Lease fences are durable PostgreSQL int64 counters, not asset amounts.
  fence: z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n),
};
export const textRequestSchema = z.strictObject({
  prompt:z.string().min(1).max(TEXT_LIMITS.maxPromptBytes).refine(value=>Buffer.byteLength(value,"utf8")<=TEXT_LIMITS.maxPromptBytes),
  maxTokens:z.number().int().min(1).max(TEXT_LIMITS.maxOutputTokens),seed:z.number().int().min(0).max(2147483647),
});
export const textResultSchema = z.strictObject({
  text:z.string().min(1).max(TEXT_LIMITS.maxOutputBytes).refine(value=>Buffer.byteLength(value,"utf8")<=TEXT_LIMITS.maxOutputBytes),
  generatedTokens:z.number().int().min(0).max(TEXT_LIMITS.maxOutputTokens),finishReason:z.enum(["stop","length"]),
});
export const textChunkSchema = z.strictObject({
  sequence:z.number().int().min(1).max(TEXT_LIMITS.maxStreamChunks),
  delta:z.string().max(TEXT_LIMITS.maxChunkBytes).refine(value=>Buffer.byteLength(value,"utf8")<=TEXT_LIMITS.maxChunkBytes),
  tokenIds:z.array(z.number().int().min(0).max(2147483647)).min(1).max(TEXT_LIMITS.maxChunkTokens),
  chunkDigest:digestSchema,
});
export type TextChunk = z.infer<typeof textChunkSchema>;

/** Buffered media job limits (ADR 0007). Every layer reads these instead of literals. */
export const MEDIA_LIMITS = Object.freeze({
  embedding: Object.freeze({ maxInputs: 64, maxInputBytes: 8192, maxTotalBytes: 65536, maxInputTokens: 32768, dimensions: 1024 }),
  transcription: Object.freeze({ sampleRate: 16000, minSeconds: 1, maxSeconds: 300, maxAudioBytes: 9600044, maxTranscriptBytes: 65536 }),
  image: Object.freeze({ maxPromptBytes: 2048, sizes: Object.freeze([512, 768, 1024] as const), maxSteps: 8, maxImages: 4, maxImageBytes: 4194304 }),
  artifactPartBytes: 262144,
} as const);
const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
export const artifactContentTypeSchema = z.enum(["audio/wav", "image/png", "application/vnd.excess.float32le"]);
export const artifactRefSchema = z.strictObject({
  digest: digestSchema,
  bytes: z.number().int().min(1).max(MEDIA_LIMITS.transcription.maxAudioBytes),
  contentType: artifactContentTypeSchema,
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export const embeddingRequestSchema = z.strictObject({
  kind: z.literal("embedding"),
  inputs: z.array(z.string().min(1).max(MEDIA_LIMITS.embedding.maxInputBytes).refine(value => utf8Bytes(value) <= MEDIA_LIMITS.embedding.maxInputBytes))
    .min(1).max(MEDIA_LIMITS.embedding.maxInputs).refine(inputs => inputs.reduce((sum, value) => sum + utf8Bytes(value), 0) <= MEDIA_LIMITS.embedding.maxTotalBytes),
});
export const embeddingResultSchema = z.strictObject({
  kind: z.literal("embedding"),
  dimensions: z.literal(MEDIA_LIMITS.embedding.dimensions),
  count: z.number().int().min(1).max(MEDIA_LIMITS.embedding.maxInputs),
  inputTokens: z.number().int().min(1).max(MEDIA_LIMITS.embedding.maxInputTokens),
  vectors: artifactRefSchema.refine(ref => ref.contentType === "application/vnd.excess.float32le"),
}).refine(result => result.vectors.bytes === result.count * result.dimensions * 4 && result.inputTokens >= result.count);
export const transcriptionRequestSchema = z.strictObject({
  kind: z.literal("transcription"),
  audio: artifactRefSchema.refine(ref => ref.contentType === "audio/wav"),
  durationMs: z.number().int().min(MEDIA_LIMITS.transcription.minSeconds * 1000).max(MEDIA_LIMITS.transcription.maxSeconds * 1000),
  language: z.string().regex(/^[a-z]{2,8}$/).optional(),
});
export const transcriptionResultSchema = z.strictObject({
  kind: z.literal("transcription"),
  text: z.string().max(MEDIA_LIMITS.transcription.maxTranscriptBytes).refine(value => utf8Bytes(value) <= MEDIA_LIMITS.transcription.maxTranscriptBytes),
  audioSeconds: z.number().int().min(MEDIA_LIMITS.transcription.minSeconds).max(MEDIA_LIMITS.transcription.maxSeconds),
});
export const imageRequestSchema = z.strictObject({
  kind: z.literal("image"),
  prompt: z.string().min(1).max(MEDIA_LIMITS.image.maxPromptBytes).refine(value => utf8Bytes(value) <= MEDIA_LIMITS.image.maxPromptBytes),
  width: z.union([z.literal(512), z.literal(768), z.literal(1024)]),
  height: z.union([z.literal(512), z.literal(768), z.literal(1024)]),
  steps: z.number().int().min(1).max(MEDIA_LIMITS.image.maxSteps),
  count: z.number().int().min(1).max(MEDIA_LIMITS.image.maxImages),
  seed: z.number().int().min(0).max(2147483647),
}).refine(request => request.width === request.height);
export const imageResultSchema = z.strictObject({
  kind: z.literal("image"),
  width: z.union([z.literal(512), z.literal(768), z.literal(1024)]),
  height: z.union([z.literal(512), z.literal(768), z.literal(1024)]),
  images: z.array(artifactRefSchema.refine(ref => ref.contentType === "image/png" && ref.bytes <= MEDIA_LIMITS.image.maxImageBytes)).min(1).max(MEDIA_LIMITS.image.maxImages),
});
export const mediaRequestSchema = z.union([embeddingRequestSchema, transcriptionRequestSchema, imageRequestSchema]);
export const mediaResultSchema = z.union([embeddingResultSchema, transcriptionResultSchema, imageResultSchema]);
export type MediaKind = "embedding" | "transcription" | "image";
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export type MediaResult = z.infer<typeof mediaResultSchema>;
/** Billable units a media result claims: input tokens, whole audio seconds or delivered images. */
export function mediaResultUnits(result: MediaResult): number {
  return result.kind === "embedding" ? result.inputTokens : result.kind === "transcription" ? result.audioSeconds : result.images.length;
}
const artifactPartIdentity = {
  digest: digestSchema,
  part: z.number().int().min(0).max(Math.ceil(MEDIA_LIMITS.transcription.maxAudioBytes / MEDIA_LIMITS.artifactPartBytes) - 1),
};
export const workerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope, type: z.literal("worker.heartbeat"),
    data: z.strictObject({
      deviceId: z.uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      availableSlots: z.number().int().min(0).max(32),
      // Legacy liveness-only heartbeats do not establish schedulable capacity.
      totalSlots: z.number().int().min(0).max(32).optional(),
      capabilityDigests: z.array(digestSchema).max(128),
    }).refine(data => data.totalSlots === undefined || data.availableSlots <= data.totalSlots),
  }),
  z.strictObject({
    ...envelope, type: z.literal("worker.poll"), data: z.strictObject({ deviceId: z.uuid() }),
  }),
  z.strictObject({
    // A supplier's public ask: net units per output token in one asset. probedAt is
    // the worker's own report of its last local probe, not proof of honest execution.
    ...envelope, type: z.literal("worker.offer"),
    data: z.strictObject({
      deviceId: z.uuid(), capabilityDigest: digestSchema, assetId: z.uuid(),
      netUnits: baseUnitsSchema.refine(value => BigInt(value) > 0n),
      slots: z.number().int().min(1).max(32), probedAt: z.iso.datetime(),
    }),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.started"), data: z.strictObject(attemptIdentity),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.input"), data: z.strictObject(attemptIdentity),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.renew"), data: z.strictObject(attemptIdentity),
  }),
  z.strictObject({
    ...envelope,type:z.literal("job.chunk"),data:z.strictObject({...attemptIdentity,...textChunkSchema.shape}),
  }),
  z.strictObject({
    // Reads one part of an input artifact of the worker's current live lease (ADR 0007).
    ...envelope, type: z.literal("job.artifact.read"), data: z.strictObject({ ...attemptIdentity, ...artifactPartIdentity }),
  }),
  z.strictObject({
    // Uploads one part of an output artifact; the server checks the whole digest on the last part.
    ...envelope, type: z.literal("job.artifact"),
    data: z.strictObject({
      ...attemptIdentity, ...artifactPartIdentity,
      bytes: artifactRefSchema.shape.bytes, contentType: artifactContentTypeSchema,
      parts: z.number().int().min(1).max(Math.ceil(MEDIA_LIMITS.transcription.maxAudioBytes / MEDIA_LIMITS.artifactPartBytes)),
      data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(MEDIA_LIMITS.artifactPartBytes / 3) * 4),
    }).refine(data => data.part < data.parts),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.failed"),
    data: z.strictObject({ ...attemptIdentity, reason: z.enum(["busy", "execution_error", "cancelled_locally"]) }),
  }),
  z.strictObject({
    ...envelope, type: z.literal("job.result"),
    data: z.strictObject({
      ...attemptIdentity,
      outputDigest: digestSchema,
      // A worker declaration is not authoritative billing or delivery evidence.
      reportedUnits: baseUnitsSchema,
      // Optional only for legacy digest-only fixtures; executable jobs require it. Media results reference uploaded artifacts.
      output: z.union([textResultSchema, mediaResultSchema]).optional(),
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

export const journalPostSchema = z.strictObject({
  assetId: z.uuid().transform(value => value.toLowerCase()),
  fundingSource: z.enum(["custody", "operator_credit"]),
  idempotencyScope: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(128),
  reason: z.string().min(1).max(500),
  correlationId: z.uuid().transform(value => value.toLowerCase()),
  entries: z.array(z.strictObject({
    accountId: z.uuid().transform(value => value.toLowerCase()),
    amount: z.string().regex(/^-?[1-9][0-9]{0,77}$/).refine(value => {
      const amount = BigInt(value);
      return amount >= -MAX_BASE_UNITS && amount <= MAX_BASE_UNITS;
    }),
  })).min(2).max(64),
}).superRefine((input, context) => {
  if (new Set(input.entries.map(entry => entry.accountId)).size !== input.entries.length) {
    context.addIssue({ code: "custom", message: "Duplicate ledger account" });
  }
  if (input.entries.every(entry => /^-?[1-9][0-9]{0,77}$/.test(entry.amount)) &&
      input.entries.reduce((total, entry) => total + BigInt(entry.amount), 0n) !== 0n) {
    context.addIssue({ code: "custom", message: "Journal entries must sum to zero" });
  }
});
export type JournalPost = z.infer<typeof journalPostSchema>;
export const jobEventSchema = z.strictObject({
  id: z.uuid().transform(value => value.toLowerCase()),
  jobId: z.uuid().transform(value => value.toLowerCase()),
  attemptId: z.uuid().transform(value => value.toLowerCase()).nullable(),
  correlationId: z.uuid().transform(value => value.toLowerCase()),
  eventType: z.enum(["job.quoted","job.reserved","job.queued","job.leased","job.running","job.delivery_started","job.verifying","job.succeeded","job.failed","job.cancelled","job.expired"]),
  cursor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value)<=9223372036854775807n),
  payload: z.record(z.string().max(128),z.json()),
});
export type JobEvent = z.infer<typeof jobEventSchema>;
