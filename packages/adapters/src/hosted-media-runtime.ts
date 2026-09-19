import { MEDIA_LIMITS } from "@excess/protocol";
import { AdapterError } from "./manifest.js";
import { parsePng } from "./media-format.js";
import { HostedProviderError, priceAtMost, type LiveEndpoint } from "./hosted-runtime.js";
import type { HostedMediaEntry } from "./hosted-media-catalog.js";

/** OpenRouter calls for house media (hosted-media-catalog.ts): /embeddings, /audio/transcriptions and /images. Like the text
 * client it never logs or returns request or provider error text: failures surface as fixed PROVIDER_* codes, and an HTTP
 * error response is marked charged "none" because no generation started. */
export interface HostedEmbedding { vectors: Float32Array[]; promptTokens: number | null; costCredits: number | null }
export interface HostedTranscript { text: string; seconds: number | null; costCredits: number | null }
export interface HostedImage { png: Buffer; costCredits: number | null }
/** Every call is pinned to `providers`, the providers whose listed rate passed the last price check, with fallbacks off:
 * on 19 September 2026 an unpinned Whisper request was routed to a provider three times dearer with a ten-second minimum. */
export interface HostedMediaClient {
  embed(entry: HostedMediaEntry, inputs: readonly string[], providers: readonly string[], signal: AbortSignal): Promise<HostedEmbedding>;
  transcribe(entry: HostedMediaEntry, wav: Buffer, language: string | undefined, providers: readonly string[], signal: AbortSignal): Promise<HostedTranscript>;
  image(entry: HostedMediaEntry, request: { prompt: string; size: number; seed: number }, providers: readonly string[], signal: AbortSignal): Promise<HostedImage>;
}
/** OpenRouter provider slugs from endpoint tags ("google-vertex/us-central1" -> "google-vertex"), without duplicates. */
export const providerSlugs = (tags: readonly string[]): string[] => [...new Set(tags.map(tag => tag.split("/")[0]!).filter(slug => /^[a-z0-9._-]{1,64}$/.test(slug)))];
const routing = (providers: readonly string[]) => {
  if (!providers.length) throw new HostedProviderError("PROVIDER_NO_ENDPOINT", null, "none");
  return { only: [...providers], allow_fallbacks: false };
};
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
function providerCode(status: number): string {
  return status === 400 ? "PROVIDER_BAD_REQUEST" : status === 401 || status === 403 ? "PROVIDER_UNAUTHORIZED" : status === 402 ? "PROVIDER_CREDITS_EXHAUSTED"
    : status === 404 ? "PROVIDER_NO_ENDPOINT" : status === 408 ? "PROVIDER_TIMEOUT" : status === 413 ? "PROVIDER_REQUEST_TOO_LARGE"
    : status === 429 ? "PROVIDER_RATE_LIMITED" : status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED";
}

/** Unit-length float32 vectors of exactly the served dimensions; a provider's truncated Matryoshka vector is renormalised. */
export function normalizedVectors(data: unknown, expected: number, dimensions: number = MEDIA_LIMITS.embedding.dimensions): Float32Array[] {
  if (!Array.isArray(data) || data.length !== expected) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
  const vectors: Float32Array[] = new Array(expected);
  for (const item of data) {
    const row = item as { index?: unknown; embedding?: unknown } | null, index = count(row?.index);
    if (index === null || index >= expected || vectors[index] || !Array.isArray(row?.embedding) || row!.embedding.length !== dimensions) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
    const values = row!.embedding as unknown[];
    let sum = 0;
    for (const value of values) { if (typeof value !== "number" || !Number.isFinite(value)) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE"); sum += value * value; }
    const norm = Math.sqrt(sum);
    if (!(norm > 0)) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
    vectors[index] = Float32Array.from(values as number[], value => value / norm);
  }
  return vectors;
}

export function createOpenRouterMediaClient(options: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; title?: string }): HostedMediaClient {
  if (typeof options.apiKey !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(options.apiKey)) throw new AdapterError("OPENROUTER_API_KEY_INVALID");
  const base = new URL(options.baseUrl ?? "https://openrouter.ai/api/v1/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new AdapterError("OPENROUTER_BASE_URL_INVALID");
  const call = options.fetch ?? fetch, title = options.title ?? "EXCESS Compute";
  /** One request; an HTTP error or unreachable provider started no generation, so nothing was charged. */
  async function send(path: string, body: string, signal: AbortSignal, maxBytes: number): Promise<Record<string, unknown>> {
    let response: Response;
    const headers: Record<string, string> = { authorization: "Bearer " + options.apiKey, "x-title": title, "content-type": "application/json" };
    try { response = await call(new URL(path, base), { method: "POST", headers, body, redirect: "error", signal }); }
    catch { throw new HostedProviderError(signal.aborted ? "PROVIDER_ABORTED" : "PROVIDER_UNREACHABLE", null, "none"); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HostedProviderError(providerCode(response.status), response.status, "none"); }
    let text: string;
    try { text = await response.text(); } catch { throw new HostedProviderError(signal.aborted ? "PROVIDER_ABORTED" : "PROVIDER_STREAM_INTERRUPTED"); }
    if (text.length > maxBytes) throw new HostedProviderError("PROVIDER_RESPONSE_TOO_LARGE", response.status);
    try { const value = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; }
    catch { /* below */ }
    throw new HostedProviderError("PROVIDER_INVALID_RESPONSE", response.status);
  }
  const usageOf = (value: Record<string, unknown>) => (value.usage && typeof value.usage === "object" ? value.usage : {}) as Record<string, unknown>;
  return {
    async embed(entry, inputs, providers, signal) {
      if (entry.kind !== "embedding") throw new AdapterError("HOSTED_KIND_MISMATCH");
      const body = { model: entry.providerModel, input: [...inputs], encoding_format: "float", ...(entry.options.dimensions ? { dimensions: entry.options.dimensions } : {}),
        provider: { ...routing(providers), max_price: { prompt: Number(entry.providerPricing.listedUsdPerM) } } };
      const reply = await send("embeddings", JSON.stringify(body), signal, 64 * 1048576), usage = usageOf(reply);
      return { vectors: normalizedVectors(reply.data, inputs.length), promptTokens: count(usage.prompt_tokens), costCredits: numeric(usage.cost) };
    },
    async transcribe(entry, wav, language, providers, signal) {
      if (entry.kind !== "transcription") throw new AdapterError("HOSTED_KIND_MISMATCH");
      // The JSON form carries provider routing; a 300-second recording is about 12.8 MB of base64.
      const body = { model: entry.providerModel, input_audio: { data: wav.toString("base64"), format: "wav" }, response_format: "json",
        ...(language ? { language } : {}), provider: routing(providers) };
      const reply = await send("audio/transcriptions", JSON.stringify(body), signal, 1048576), usage = usageOf(reply);
      if (typeof reply.text !== "string") throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
      const text = reply.text.trim();
      if (Buffer.byteLength(text, "utf8") > MEDIA_LIMITS.transcription.maxTranscriptBytes) throw new HostedProviderError("PROVIDER_OUTPUT_TOO_LARGE");
      return { text, seconds: numeric(usage.seconds), costCredits: numeric(usage.cost) };
    },
    async image(entry, request, providers, signal) {
      if (entry.kind !== "image") throw new AdapterError("HOSTED_KIND_MISMATCH");
      const body = { model: entry.providerModel, prompt: request.prompt, n: 1, size: request.size + "x" + request.size, output_format: "png",
        ...(entry.options.seed ? { seed: request.seed } : {}), provider: routing(providers) };
      const reply = await send("images", JSON.stringify(body), signal, Math.ceil(MEDIA_LIMITS.image.maxImageBytes / 3) * 4 + 65536), usage = usageOf(reply);
      const first = Array.isArray(reply.data) && reply.data.length === 1 ? reply.data[0] as Record<string, unknown> : null;
      if (!first || typeof first.b64_json !== "string" || (first.media_type !== undefined && first.media_type !== "image/png")) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
      const png = Buffer.from(first.b64_json, "base64");
      let size: { width: number; height: number };
      try { size = parsePng(png); } catch { throw new HostedProviderError("PROVIDER_INVALID_IMAGE"); }
      // A provider that ignores the size would return an image the buyer did not buy.
      if (size.width !== request.size || size.height !== request.size) throw new HostedProviderError("PROVIDER_WRONG_IMAGE_SIZE");
      return { png, costCredits: numeric(usage.cost) };
    },
  };
}

/** A live endpoint can serve a house media entry while it is up and its listed rate (per input token, audio second or
 * output image token) is at or below the rate the house price was measured against. */
export function eligibleMediaEndpoints(entry: HostedMediaEntry, endpoints: readonly LiveEndpoint[], withinCeiling = true): LiveEndpoint[] {
  return endpoints.filter(endpoint => {
    if (endpoint.status !== 0) return false;
    const listed = entry.providerPricing.listedField === "image_output" ? endpoint.imageOutputUsdPerM : endpoint.promptUsdPerM;
    return listed !== "unknown" && (!withinCeiling || priceAtMost(listed, entry.providerPricing.listedUsdPerM));
  });
}
