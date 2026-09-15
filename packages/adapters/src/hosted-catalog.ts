import { INPUT_PRICING, requestDigest, TEXT_LIMITS } from "@excess/protocol";
import type { ModelInfo } from "./model-info.js";

/** EXCESS house supply (ADR 0008): large open-weight text models the operator serves through OpenRouter, listed beside
 * supplier-hosted models. Prompts leave EXCESS for a hosted inference provider, so the trust class is provider_visible. */
export const HOUSE_SUPPLIER_NAME = "EXCESS house supply";
export const HOUSE_DISCLOSURE = "Supplied by EXCESS house supply — prompts are processed by a hosted inference provider.";
/** OpenRouter charges 5.5% when credits are bought, so one credit of usage costs 1.055 USD. */
export const OPENROUTER_CREDIT_FEE_BPS = 550;
/** House margin over provider cost in basis points: 30% by default and never below 10%. */
export const HOUSE_MARGIN_BPS = Object.freeze({ default: 3000, minimum: 1000, maximum: 50000 });
/** Context served for hosted text: the prompt token bound plus the output cap. */
export const HOSTED_CONTEXT_TOKENS = INPUT_PRICING.maxPromptTokens + TEXT_LIMITS.maxOutputTokens;
/** Providers OpenRouter lists as unable to stop a stream when the request is aborted; they would keep generating and billing
 * after a buyer cancels (openrouter.ai/docs/api-reference/streaming, checked 15 September 2026). */
export const OPENROUTER_IGNORED_PROVIDERS: readonly string[] = Object.freeze(["amazon-bedrock", "groq", "modal", "google-vertex", "google-ai-studio",
  "minimax", "perplexity", "mistral", "ai21", "featherless"]);

/** How reasoning is requested: never offered, turned off, or kept (the model always reasons) with its text excluded from the
 * answer. Kept reasoning tokens are provider completion tokens and are billed as output tokens. */
export type HostedReasoning = "none" | "disabled" | "hidden" | "hidden_low";
/** Provider price ceiling in USD per million tokens. Every request carries it as OpenRouter provider.max_price. */
export interface ProviderPricing { readonly promptUsdPerM: string; readonly completionUsdPerM: string; readonly checkedAt: string }
export interface HostedModelEntry {
  readonly id: string; readonly displayName: string; readonly hosting: "house"; readonly info: ModelInfo;
  readonly provider: "openrouter"; readonly providerModel: string; readonly providerPricing: ProviderPricing;
  /** Precisions a provider may serve; OpenRouter provider.quantizations. */
  readonly quantizations: readonly string[];
  readonly reasoning: HostedReasoning;
  readonly capability: Readonly<Record<string, unknown>> & { readonly model: string; readonly runtime: string; readonly providerModel: string;
    readonly contextTokens: number; readonly maxPromptBytes: number; readonly maxOutputTokens: number };
  readonly capabilityDigest: string;
}

type Input = Omit<HostedModelEntry, "hosting" | "provider" | "capability" | "capabilityDigest" | "info" | "providerPricing"> &
  { info: Omit<ModelInfo, "contextTokens" | "format" | "modalities" | "reasoning">; prompt: string; completion: string };
const CHECKED_AT = "2026-09-15T00:00:00Z";
const FP8_OR_BETTER = Object.freeze(["fp8", "fp16", "bf16", "fp32", "unknown"]);
function hosted(input: Input): HostedModelEntry {
  const { prompt, completion, info, ...entry } = input;
  // Prices are deliberately outside the digest: a refreshed snapshot changes offers, not what a supplier is approved to serve.
  const capability = Object.freeze({
    version: 1, adapterId: "excess.hosted-text", adapterVersion: "0.1.0", hosting: "house",
    runtime: "openrouter", provider: "openrouter", providerModel: entry.providerModel, modelId: entry.id, model: entry.displayName,
    meteringUnit: "output_token", inputMeteringUnit: "input_token", trustClass: "provider_visible",
    deliveryMode: "stream", billingPolicy: "acknowledged_tokens_v1",
    contextTokens: HOSTED_CONTEXT_TOKENS, maxPromptBytes: TEXT_LIMITS.maxPromptBytes, maxPromptTokens: INPUT_PRICING.maxPromptTokens,
    promptTemplateTokens: INPUT_PRICING.promptTemplateTokens, maxOutputBytes: TEXT_LIMITS.maxOutputBytes, maxOutputTokens: TEXT_LIMITS.maxOutputTokens,
    promptFormat: "single-user-message-v1", sampling: "provider-default", seed: "not_forwarded",
    quantizations: [...entry.quantizations], reasoning: entry.reasoning, ignoredProviders: [...OPENROUTER_IGNORED_PROVIDERS],
  });
  const reasoning = entry.reasoning === "hidden" || entry.reasoning === "hidden_low";
  const precision = entry.quantizations.includes("fp4") || entry.quantizations.includes("int4") ? "native low-bit or higher precision" : "FP8 or higher precision";
  return Object.freeze({ ...entry, hosting: "house" as const, provider: "openrouter" as const,
    quantizations: Object.freeze([...entry.quantizations]),
    providerPricing: Object.freeze({ promptUsdPerM: prompt, completionUsdPerM: completion, checkedAt: CHECKED_AT }),
    info: Object.freeze({ ...info, contextTokens: HOSTED_CONTEXT_TOKENS, format: "Hosted API via OpenRouter (" + precision + ")",
      modalities: Object.freeze(["text"] as const), reasoning }),
    capability, capabilityDigest: requestDigest(capability) });
}
const HF = (repository: string) => "https://huggingface.co/" + repository;

/** The house lineup. Slugs, contexts and endpoint prices were read from openrouter.ai/api/v1/models and each model's
 * endpoints on 15 September 2026; scripts/ops/openrouter-catalog.mjs re-checks them. A price ceiling covers the cheapest
 * eligible endpoints (at most three, within twice the cheapest), so routing has more than one provider where possible. */
export const HOSTED_CATALOG: readonly HostedModelEntry[] = Object.freeze([
  hosted({ id: "house-deepseek-v4-pro", displayName: "DeepSeek V4 Pro (0813)", providerModel: "deepseek/deepseek-v4-pro-0813", prompt: "0.66", completion: "1.98",
    quantizations: FP8_OR_BETTER, reasoning: "disabled",
    info: { publisher: "DeepSeek", family: "DeepSeek V4", parametersB: 1650, maxContextTokens: 1048576, licence: "MIT", sourceUrl: HF("deepseek-ai/DeepSeek-V4-Pro-0813"),
      summary: "DeepSeek's flagship mixture-of-experts model for hard reasoning, coding and long documents, served here with thinking turned off.", released: "2026-08" } }),
  hosted({ id: "house-kimi-k2.5", displayName: "Kimi K2.5", providerModel: "moonshotai/kimi-k2.5", prompt: "0.57", completion: "2.85",
    // Kimi K2.5 is released with native INT4 weights.
    quantizations: Object.freeze(["int4", ...FP8_OR_BETTER]), reasoning: "disabled",
    info: { publisher: "Moonshot AI", family: "Kimi K2", parametersB: 1000, activeParametersB: 32, maxContextTokens: 262144, licence: "Modified MIT", sourceUrl: HF("moonshotai/Kimi-K2.5"),
      summary: "A trillion-parameter mixture-of-experts model strong at coding, agentic tasks and writing, served here in instant (non-thinking) mode.", released: "2026-01" } }),
  // The live check on 15 September 2026 saw its only provider reason even with reasoning disabled, so it is sold as a reasoning model.
  hosted({ id: "house-hermes-4-405b", displayName: "Hermes 4 405B", providerModel: "nousresearch/hermes-4-405b", prompt: "1", completion: "3",
    quantizations: FP8_OR_BETTER, reasoning: "hidden",
    info: { publisher: "Nous Research", family: "Hermes 4", parametersB: 405, maxContextTokens: 131072, licence: "Llama 3.1 Community", sourceUrl: HF("NousResearch/Hermes-4-405B"),
      summary: "A 405B dense model built on Llama 3.1 405B, tuned for steerable instruction following and creative writing. It may reason first; the reasoning is billed but not shown.", released: "2025-08" } }),
  hosted({ id: "house-qwen3-coder-480b-a35b", displayName: "Qwen3 Coder 480B A35B", providerModel: "qwen/qwen3-coder", prompt: "0.38", completion: "1.55",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba Qwen", family: "Qwen3-Coder", parametersB: 480, activeParametersB: 35, maxContextTokens: 262144, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-Coder-480B-A35B-Instruct"),
      summary: "Qwen's largest coding model: a mixture-of-experts model for code generation, repository-scale edits and tool use.", released: "2025-07" } }),
  hosted({ id: "house-deepseek-v3.2", displayName: "DeepSeek V3.2", providerModel: "deepseek/deepseek-v3.2", prompt: "0.26", completion: "0.38",
    quantizations: FP8_OR_BETTER, reasoning: "disabled",
    info: { publisher: "DeepSeek", family: "DeepSeek V3", parametersB: 685, activeParametersB: 37, maxContextTokens: 163840, licence: "MIT", sourceUrl: HF("deepseek-ai/DeepSeek-V3.2"),
      summary: "An efficient sparse-attention mixture-of-experts model with strong general, coding and agentic performance at a low price; thinking off.", released: "2025-12" } }),
  hosted({ id: "house-qwen3-235b-a22b-2507", displayName: "Qwen3 235B A22B Instruct 2507", providerModel: "qwen/qwen3-235b-a22b-2507", prompt: "0.09", completion: "0.58",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba Qwen", family: "Qwen3", parametersB: 235, activeParametersB: 22, maxContextTokens: 262144, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-235B-A22B-Instruct-2507"),
      summary: "Qwen's large instruction model without a thinking phase: multilingual, strong at instruction following, maths and writing.", released: "2025-07" } }),
  hosted({ id: "house-llama-4-maverick", displayName: "Llama 4 Maverick", providerModel: "meta-llama/llama-4-maverick", prompt: "0.27", completion: "0.85",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Meta", family: "Llama 4", parametersB: 400, activeParametersB: 17, maxContextTokens: 1048576, licence: "Llama 4 Community", sourceUrl: HF("meta-llama/Llama-4-Maverick-17B-128E-Instruct"),
      summary: "Meta's 128-expert mixture-of-experts model for fast general chat and multilingual tasks; served for text only.", released: "2025-04" } }),
  hosted({ id: "house-minimax-m2.5", displayName: "MiniMax M2.5", providerModel: "minimax/minimax-m2.5", prompt: "0.295", completion: "1.2",
    quantizations: FP8_OR_BETTER, reasoning: "hidden",
    info: { publisher: "MiniMax", family: "MiniMax M2", parametersB: 229, maxContextTokens: 204800, licence: "Modified MIT", sourceUrl: HF("MiniMaxAI/MiniMax-M2.5"),
      summary: "A mixture-of-experts model built for coding and agentic work. It always reasons first; the reasoning is billed but not shown.", released: "2026-02" } }),
  hosted({ id: "house-gpt-oss-120b", displayName: "gpt-oss-120b", providerModel: "openai/gpt-oss-120b", prompt: "0.037", completion: "0.17",
    // gpt-oss is released with native MXFP4 expert weights.
    quantizations: Object.freeze(["fp4", ...FP8_OR_BETTER]), reasoning: "hidden_low",
    info: { publisher: "OpenAI", family: "gpt-oss", parametersB: 117, activeParametersB: 5.1, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("openai/gpt-oss-120b"),
      summary: "OpenAI's larger open-weight reasoning model, fast and inexpensive. It reasons at low effort first; the reasoning is billed but not shown.", released: "2025-08" } }),
  hosted({ id: "house-llama-3.3-70b", displayName: "Llama 3.3 70B Instruct", providerModel: "meta-llama/llama-3.3-70b-instruct", prompt: "0.22", completion: "0.52",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Meta", family: "Llama 3.3", parametersB: 70, maxContextTokens: 131072, licence: "Llama 3.3 Community", sourceUrl: HF("meta-llama/Llama-3.3-70B-Instruct"),
      summary: "A dependable 70B dense multilingual chat model for everyday writing, summarising and question answering.", released: "2024-12" } }),
  hosted({ id: "house-qwen3-32b", displayName: "Qwen3 32B", providerModel: "qwen/qwen3-32b", prompt: "0.14", completion: "0.57",
    quantizations: FP8_OR_BETTER, reasoning: "disabled",
    info: { publisher: "Alibaba Qwen", family: "Qwen3", parametersB: 32.8, maxContextTokens: 40960, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-32B"),
      summary: "Qwen's largest dense Qwen3 model: a fast, capable general assistant, served with thinking turned off.", released: "2025-04" } }),
  hosted({ id: "house-gemma-3-27b", displayName: "Gemma 3 27B", providerModel: "google/gemma-3-27b-it", prompt: "0.1", completion: "0.3",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Google", family: "Gemma 3", parametersB: 27, maxContextTokens: 131072, licence: "Gemma", sourceUrl: HF("google/gemma-3-27b-it"),
      summary: "Google's largest Gemma 3 model: a compact multilingual assistant with good reasoning for its size; served for text only.", released: "2025-03" } }),
  hosted({ id: "house-gpt-oss-20b", displayName: "gpt-oss-20b", providerModel: "openai/gpt-oss-20b", prompt: "0.03", completion: "0.14",
    quantizations: Object.freeze(["fp4", ...FP8_OR_BETTER]), reasoning: "hidden_low",
    info: { publisher: "OpenAI", family: "gpt-oss", parametersB: 21, activeParametersB: 3.6, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("openai/gpt-oss-20b"),
      summary: "OpenAI's small open-weight reasoning model: the cheapest, fastest house option. Low-effort reasoning is billed but not shown.", released: "2025-08" } }),
]);
export function hostedEntry(id: string): HostedModelEntry | undefined { return HOSTED_CATALOG.find(entry => entry.id === id); }
export const hostedEntryByDigest = (digest: string): HostedModelEntry | undefined => HOSTED_CATALOG.find(entry => entry.capabilityDigest === digest);
export const isHostedCapability = (digest: unknown): boolean => typeof digest === "string" && hostedEntryByDigest(digest) !== undefined;

// ---------- Pricing ----------
const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/;
function decimal(value: string): { numerator: bigint; scale: bigint } {
  if (!DECIMAL.test(value)) throw new RangeError("Invalid decimal price");
  const [whole, fraction = ""] = value.split(".");
  return { numerator: BigInt(whole! + fraction), scale: 10n ** BigInt(fraction.length) };
}
export function validMarginBps(marginBps: number): number {
  if (!Number.isSafeInteger(marginBps) || marginBps < HOUSE_MARGIN_BPS.minimum || marginBps > HOUSE_MARGIN_BPS.maximum) throw new RangeError("House margin must be 1000..50000 basis points");
  return marginBps;
}
/** The one house pricing function: supplier net base units per token =
 * ceil(providerUsdPerToken × (1 + credit fee) × (1 + margin) × 10^decimals), at least one base unit. Exact integer arithmetic.
 * Buyers pay this net plus the platform fee on top. */
export function houseUnitPrice(usdPerMillion: string, marginBps: number = HOUSE_MARGIN_BPS.default, decimals = 6): bigint {
  const { numerator, scale } = decimal(usdPerMillion);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("Invalid asset decimals");
  const top = numerator * BigInt(10000 + OPENROUTER_CREDIT_FEE_BPS) * BigInt(10000 + validMarginBps(marginBps)) * 10n ** BigInt(decimals);
  const bottom = scale * 100_000_000n * 1_000_000n;
  const units = (top + bottom - 1n) / bottom;
  return units < 1n ? 1n : units;
}
export interface HousePrices { inputNetUnits: bigint; outputNetUnits: bigint }
export const housePrices = (entry: HostedModelEntry, marginBps: number = HOUSE_MARGIN_BPS.default, decimals = 6): HousePrices => ({
  inputNetUnits: houseUnitPrice(entry.providerPricing.promptUsdPerM, marginBps, decimals),
  outputNetUnits: houseUnitPrice(entry.providerPricing.completionUsdPerM, marginBps, decimals),
});
/** Worst-case provider cost of a job in USD, including the credit fee, as an exact fraction numerator / denominator. */
export function providerCostUsd(pricing: Pick<ProviderPricing, "promptUsdPerM" | "completionUsdPerM">, promptTokens: number, completionTokens: number): { numerator: bigint; denominator: bigint } {
  const p = decimal(pricing.promptUsdPerM), c = decimal(pricing.completionUsdPerM);
  const scale = p.scale > c.scale ? p.scale : c.scale;
  const tokens = (p.numerator * (scale / p.scale)) * BigInt(promptTokens) + (c.numerator * (scale / c.scale)) * BigInt(completionTokens);
  return { numerator: tokens * BigInt(10000 + OPENROUTER_CREDIT_FEE_BPS), denominator: scale * 1_000_000n * 10000n };
}
