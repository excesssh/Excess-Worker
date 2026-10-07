import { createHash } from "node:crypto";
import { parsePng, parseWav, type MediaOutput } from "@excess/adapters";
import { MEDIA_LIMITS, mediaRequestSchema, mediaResultSchema, mediaResultUnits, type ArtifactRef, type MediaRequest, type MediaResult } from "@excess/protocol";

export type WindowsMediaArtifactProof = Readonly<{ ref: ArtifactRef; data: string }>;
export const WINDOWS_MEDIA_PROOF_BYTES = Math.ceil(MEDIA_LIMITS.image.maxImages * MEDIA_LIMITS.image.maxImageBytes / 3) * 4 + 512 * 1024;
const fail = (): never => { throw Error("CONTROLLER_EXECUTION_MEDIA_INVALID"); };
export const mediaRefs = (result: MediaResult): ArtifactRef[] => result.kind === "embedding" ? [result.vectors] : result.kind === "image" ? result.images : [];
export const mediaHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function mediaPart(data: unknown, size: number): Buffer {
  if (typeof data !== "string" || data.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return fail();
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== data) return fail();
  return bytes;
}
export function checkedMediaRequest(value: unknown, maxUnits: string): MediaRequest {
  const request = mediaRequestSchema.parse(value), units = BigInt(maxUnits);
  if (request.kind === "embedding" ? BigInt(request.inputs.length) > units :
      request.kind === "transcription" ? BigInt(Math.ceil(request.durationMs / 1000)) !== units : BigInt(request.count) !== units) fail();
  if (request.kind === "transcription" && request.audio.bytes > MEDIA_LIMITS.transcription.maxAudioBytes) fail();
  return request;
}
export function checkedMediaInputs(request: MediaRequest, inputs: ReadonlyMap<string, Buffer>): void {
  if (request.kind !== "transcription") { if (inputs.size) fail(); return; }
  const data = inputs.get(request.audio.digest);
  if (inputs.size !== 1 || !data || data.length !== request.audio.bytes || mediaHash(data) !== request.audio.digest ||
      Math.abs(parseWav(data).durationMs - request.durationMs) >= 1) fail();
}
export function checkedMediaArtifacts(result: MediaResult, values: unknown): WindowsMediaArtifactProof[] {
  if (!Array.isArray(values) || values.length > MEDIA_LIMITS.image.maxImages) return fail();
  const refs = [...new Map(mediaRefs(result).map(ref => [ref.digest, ref])).values()];
  if (values.length !== refs.length) return fail();
  const seen = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "data,ref") return fail();
    const artifact = value as WindowsMediaArtifactProof, ref = refs.find(item => item.digest === artifact.ref?.digest);
    if (!ref || seen.has(ref.digest) || JSON.stringify(ref) !== JSON.stringify(artifact.ref)) return fail();
    const bytes = mediaPart(artifact.data, ref.bytes);
    if (mediaHash(bytes) !== ref.digest) fail();
    if (result.kind === "embedding") {
      for (let i = 0; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) fail();
    } else if (result.kind === "image") {
      const png = parsePng(bytes);
      if (png.width !== result.width || png.height !== result.height) fail();
    }
    seen.add(ref.digest);
    return { ref, data: artifact.data };
  });
}
export function checkedMediaOutput(request: MediaRequest, value: MediaOutput, maxUnits: string): MediaOutput {
  let result = mediaResultSchema.parse(value.result);
  if (result.kind === "embedding" && request.kind === "embedding") {
    if (result.count !== request.inputs.length) fail();
    result = { ...result, inputTokens: Math.max(result.count, Math.min(result.inputTokens, Number(maxUnits))) };
  } else if (result.kind === "transcription" && request.kind === "transcription") {
    if (result.audioSeconds !== Math.ceil(request.durationMs / 1000)) fail();
  } else if (result.kind === "image" && request.kind === "image") {
    if (result.width !== request.width || result.height !== request.height || result.images.length !== request.count) fail();
  } else fail();
  if (BigInt(mediaResultUnits(result)) > BigInt(maxUnits)) fail();
  const artifacts = [...new Map(value.artifacts.map(item => [item.ref.digest, item])).values()];
  checkedMediaArtifacts(result, artifacts.map(item => ({ ref: item.ref, data: item.data.toString("base64") })));
  return { result, artifacts };
}
