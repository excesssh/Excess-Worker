import { TEXT_LIMITS } from "@excess/protocol";
import { AdapterError, type TextRequest } from "./manifest.js";
import { OPENROUTER_IGNORED_PROVIDERS, type HostedModelEntry } from "./hosted-catalog.js";

/** OpenRouter streaming client for EXCESS house supply (ADR 0008). It never logs or returns request or provider error text:
 * failures surface as fixed PROVIDER_* codes. */
export interface HostedUsage { promptTokens: number; completionTokens: number; reasoningTokens: number; costCredits: number | null }
export interface HostedExecution {
  text: string;
  /** Non-empty content events. Each carries at least one generated token, so this never exceeds the completion tokens. */
  contentEvents: number;
  finishReason: string | null;
  usage: HostedUsage | null;
  generationId: string | null;
}
export interface HostedStreamOptions {
  signal: AbortSignal;
  /** Called for each non-empty content delta, in order. A rejection aborts the upstream request. */
  onContent?: (delta: string) => void | Promise<void>;
  /** Abort when no bytes arrive for this long; OpenRouter sends keep-alive comments while a provider works. */
  idleTimeoutMs?: number;
}
export interface GenerationStats { promptTokens: number | null; completionTokens: number | null; costCredits: number | null; cancelled: boolean | null }
export interface LiveEndpoint { provider: string; tag: string; quantization: string; contextLength: number | null; maxCompletionTokens: number | null;
  promptUsdPerM: string; completionUsdPerM: string; status: number | null; supportedParameters: string[] }
export class HostedProviderError extends AdapterError {
  constructor(code: string, readonly status: number | null = null, readonly charged: "none" | "unknown" = "unknown") { super(code); this.name = "HostedProviderError"; }
}

/** The exact OpenRouter request for a job: one user message, max_tokens equal to the job's reserved output tokens,
 * provider.max_price at the catalog ceiling (USD per million tokens), only allowed precisions, no provider that cannot
 * cancel a stream, and only providers that honour every parameter sent. */
export function openRouterBody(entry: HostedModelEntry, request: TextRequest): Record<string, unknown> {
  if (request.maxTokens > entry.capability.maxOutputTokens || Buffer.byteLength(request.prompt, "utf8") > entry.capability.maxPromptBytes) throw new AdapterError("HOSTED_REQUEST_EXCEEDS_LIMITS");
  const reasoning = entry.reasoning === "disabled" ? { enabled: false } : entry.reasoning === "hidden" ? { exclude: true }
    : entry.reasoning === "hidden_low" ? { effort: "low", exclude: true } : undefined;
  return {
    model: entry.providerModel, messages: [{ role: "user", content: request.prompt }], stream: true, max_tokens: request.maxTokens,
    usage: { include: true },
    provider: { max_price: { prompt: Number(entry.providerPricing.promptUsdPerM), completion: Number(entry.providerPricing.completionUsdPerM) },
      quantizations: [...entry.quantizations], ignore: [...OPENROUTER_IGNORED_PROVIDERS], require_parameters: true },
    ...(reasoning ? { reasoning } : {}),
  };
}

const MAX_STREAM_BYTES = 16 * 1048576;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function parseUsage(value: unknown): HostedUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>, details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const promptTokens = count(usage.prompt_tokens), completionTokens = count(usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  return { promptTokens, completionTokens, reasoningTokens: count(details.reasoning_tokens) ?? 0, costCredits: numeric(usage.cost) };
}
function providerCode(status: number): string {
  return status === 400 ? "PROVIDER_BAD_REQUEST" : status === 401 || status === 403 ? "PROVIDER_UNAUTHORIZED" : status === 402 ? "PROVIDER_CREDITS_EXHAUSTED"
    : status === 404 ? "PROVIDER_NO_ENDPOINT" : status === 408 ? "PROVIDER_TIMEOUT" : status === 413 ? "PROVIDER_REQUEST_TOO_LARGE"
    : status === 429 ? "PROVIDER_RATE_LIMITED" : status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED";
}

export interface OpenRouterClientOptions { apiKey: string; baseUrl?: string; fetch?: typeof fetch; title?: string }
export function createOpenRouterClient(options: OpenRouterClientOptions) {
  if (typeof options.apiKey !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(options.apiKey)) throw new AdapterError("OPENROUTER_API_KEY_INVALID");
  const base = new URL(options.baseUrl ?? "https://openrouter.ai/api/v1/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new AdapterError("OPENROUTER_BASE_URL_INVALID");
  const call = options.fetch ?? fetch;
  const headers = (json: boolean): Record<string, string> => ({ authorization: "Bearer " + options.apiKey, "x-title": options.title ?? "EXCESS house supply",
    ...(json ? { "content-type": "application/json" } : {}) });
  const url = (path: string) => new URL(path, base);
  async function readJson(response: Response, maxBytes: number): Promise<unknown> {
    const text = await response.text();
    if (text.length > maxBytes) throw new HostedProviderError("PROVIDER_RESPONSE_TOO_LARGE", response.status);
    try { return JSON.parse(text); } catch { throw new HostedProviderError("PROVIDER_INVALID_RESPONSE", response.status); }
  }

  /** Streams one completion. Resolves with the provider's usage when the stream ends normally; throws HostedProviderError
   * for HTTP errors (charged "none": no generation started) and mid-stream failures (charged "unknown"). */
  async function stream(entry: HostedModelEntry, request: TextRequest, streamOptions: HostedStreamOptions): Promise<HostedExecution> {
    const body = JSON.stringify(openRouterBody(entry, request)), idleMs = streamOptions.idleTimeoutMs ?? 60000;
    const upstream = new AbortController(), abort = () => upstream.abort();
    if (streamOptions.signal.aborted) throw new HostedProviderError("PROVIDER_ABORTED", null, "none");
    streamOptions.signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined, idleExpired = false;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => { idleExpired = true; upstream.abort(); }, idleMs); };
    const result: HostedExecution = { text: "", contentEvents: 0, finishReason: null, usage: null, generationId: null };
    let textBytes = 0, streamed = false;
    try {
      touch();
      let response: Response;
      try { response = await call(url("chat/completions"), { method: "POST", headers: headers(true), body, redirect: "error", signal: upstream.signal }); }
      catch { throw new HostedProviderError(streamOptions.signal.aborted ? "PROVIDER_ABORTED" : idleExpired ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE", null, "none"); }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new HostedProviderError(providerCode(response.status), response.status, "none");
      }
      streamed = true;
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "", bytes = 0, done = false;
      const handle = async (line: string) => {
        if (!line.startsWith("data:")) return; // Comments such as ": OPENROUTER PROCESSING" keep the connection alive.
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; return; }
        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { throw new HostedProviderError("PROVIDER_INVALID_STREAM"); }
        if (typeof event.id === "string" && event.id.length <= 256 && result.generationId === null) result.generationId = event.id;
        if (event.error !== undefined) throw new HostedProviderError("PROVIDER_STREAM_ERROR");
        const usage = parseUsage(event.usage);
        if (usage) result.usage = usage;
        const choice = Array.isArray(event.choices) ? event.choices[0] as Record<string, unknown> | undefined : undefined;
        if (!choice) return;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textBytes += Buffer.byteLength(delta.content, "utf8");
          if (textBytes > TEXT_LIMITS.maxOutputBytes) throw new HostedProviderError("PROVIDER_OUTPUT_TOO_LARGE");
          result.text += delta.content; result.contentEvents++;
          await streamOptions.onContent?.(delta.content);
        }
        if (typeof choice.finish_reason === "string") {
          result.finishReason = choice.finish_reason;
          if (choice.finish_reason === "error") throw new HostedProviderError("PROVIDER_STREAM_ERROR");
        }
      };
      while (!done) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { throw new HostedProviderError(streamOptions.signal.aborted ? "PROVIDER_ABORTED" : idleExpired ? "PROVIDER_TIMEOUT" : "PROVIDER_STREAM_INTERRUPTED"); }
        if (chunk.done) break;
        touch();
        bytes += chunk.value.length;
        if (bytes > MAX_STREAM_BYTES) throw new HostedProviderError("PROVIDER_RESPONSE_TOO_LARGE");
        try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw new HostedProviderError("PROVIDER_INVALID_STREAM"); }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          await handle(line);
          if (done) break;
        }
      }
      await reader.cancel().catch(() => {});
      if (streamOptions.signal.aborted) throw new HostedProviderError("PROVIDER_ABORTED");
      if (!done && result.usage === null) throw new HostedProviderError("PROVIDER_STREAM_INTERRUPTED");
      return result;
    } catch (error) {
      upstream.abort();
      if (error instanceof HostedProviderError) {
        // Keep what is known so the caller can reconcile tokens and cost after a failure.
        Object.assign(error, { partial: streamed ? result : null });
        throw error;
      }
      throw Object.assign(new HostedProviderError("PROVIDER_STREAM_FAILED"), { partial: streamed ? result : null });
    } finally {
      clearTimeout(idle);
      streamOptions.signal.removeEventListener("abort", abort);
    }
  }

  /** Token counts and cost of a finished, failed or cancelled generation, or null while OpenRouter has not recorded it. */
  async function generation(id: string, signal?: AbortSignal): Promise<GenerationStats | null> {
    if (!/^[A-Za-z0-9_:.-]{1,256}$/.test(id)) throw new AdapterError("GENERATION_ID_INVALID");
    const target = url("generation");
    target.searchParams.set("id", id);
    let response: Response;
    try { response = await call(target, { headers: headers(false), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
    catch { return null; }
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HostedProviderError(providerCode(response.status), response.status); }
    const data = ((await readJson(response, 65536)) as { data?: Record<string, unknown> }).data ?? {};
    return { promptTokens: count(data.native_tokens_prompt) ?? count(data.tokens_prompt), completionTokens: count(data.native_tokens_completion) ?? count(data.tokens_completion),
      costCredits: numeric(data.total_cost), cancelled: typeof data.cancelled === "boolean" ? data.cancelled : null };
  }

  /** The public endpoint list for one model: each provider's precision, limits, prices (USD per million) and parameters. */
  async function endpoints(providerModel: string, signal?: AbortSignal): Promise<LiveEndpoint[]> {
    if (!/^[a-z0-9-]+\/[a-z0-9._:-]+$/.test(providerModel)) throw new AdapterError("PROVIDER_MODEL_INVALID");
    let response: Response;
    try { response = await call(url("models/" + providerModel + "/endpoints"), { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }); }
    catch { throw new HostedProviderError("PROVIDER_UNREACHABLE"); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HostedProviderError(providerCode(response.status), response.status); }
    const list = ((await readJson(response, 1048576)) as { data?: { endpoints?: unknown[] } }).data?.endpoints;
    if (!Array.isArray(list)) throw new HostedProviderError("PROVIDER_INVALID_RESPONSE");
    return list.map(item => {
      const e = item as Record<string, unknown>, pricing = (e.pricing ?? {}) as Record<string, unknown>;
      return { provider: String(e.provider_name ?? ""), tag: String(e.tag ?? ""), quantization: String(e.quantization ?? "unknown"),
        contextLength: count(e.context_length), maxCompletionTokens: count(e.max_completion_tokens),
        promptUsdPerM: perMillion(pricing.prompt), completionUsdPerM: perMillion(pricing.completion), status: Number.isSafeInteger(e.status) ? Number(e.status) : null,
        supportedParameters: Array.isArray(e.supported_parameters) ? e.supported_parameters.filter((p): p is string => typeof p === "string") : [] };
    });
  }
  return { stream, generation, endpoints };
}
export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;

/** Parameters every house request for this entry sends, which a provider must honour (provider.require_parameters). */
export const hostedRequiredParameters = (entry: HostedModelEntry): string[] => ["max_tokens", ...(entry.reasoning === "none" ? [] : ["reasoning"])];
/** Endpoints the house request can route to: up, an allowed precision, a provider that can cancel a stream, room for the
 * served context and output, every required parameter and, unless disabled, prices at or below the catalog ceiling. */
export function eligibleEndpoints(entry: HostedModelEntry, endpoints: readonly LiveEndpoint[], withinCeiling = true): LiveEndpoint[] {
  return endpoints.filter(endpoint => endpoint.status === 0 && entry.quantizations.includes(endpoint.quantization) &&
    !OPENROUTER_IGNORED_PROVIDERS.includes(endpoint.tag.split("/")[0] ?? "") &&
    (endpoint.contextLength ?? 0) >= entry.capability.contextTokens &&
    (endpoint.maxCompletionTokens === null || endpoint.maxCompletionTokens >= entry.capability.maxOutputTokens) &&
    hostedRequiredParameters(entry).every(name => endpoint.supportedParameters.includes(name)) &&
    endpoint.promptUsdPerM !== "unknown" && endpoint.completionUsdPerM !== "unknown" &&
    (!withinCeiling || (priceAtMost(endpoint.promptUsdPerM, entry.providerPricing.promptUsdPerM) && priceAtMost(endpoint.completionUsdPerM, entry.providerPricing.completionUsdPerM))));
}
/** A per-token USD price string ("0.00000057948") as an exact decimal per million tokens ("0.57948"). */
export function perMillion(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,24})?$/.test(value)) return "unknown";
  // Shift the decimal point six places right without floating point.
  const [whole, fraction = ""] = value.split("."), point = whole!.length + 6, digits = (whole! + fraction).padEnd(point, "0");
  const decimals = digits.slice(point).replace(/0+$/, "");
  return BigInt(digits.slice(0, point)).toString() + (decimals ? "." + decimals : "");
}
/** True when a USD-per-million decimal is at or below another, compared exactly. */
export function priceAtMost(value: string, ceiling: string): boolean {
  const parts = [value, ceiling].map(text => { const [w, f = ""] = text.split("."); return { w: BigInt(w!), f }; });
  const scale = Math.max(parts[0]!.f.length, parts[1]!.f.length);
  const [a, b] = parts.map(part => part.w * 10n ** BigInt(scale) + BigInt(part.f.padEnd(scale, "0") || "0"));
  return a! <= b!;
}
