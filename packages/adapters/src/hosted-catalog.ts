import { INPUT_PRICING, requestDigest, TEXT_LIMITS } from "@excess/protocol";
import type { ModelInfo } from "./model-info.js";

/** EXCESS house supply (ADR 0008): large open-weight text models the operator serves through OpenRouter, listed beside
 * supplier-hosted models. Prompts leave EXCESS for a hosted inference provider, so the trust class is provider_visible. */
export const HOUSE_SUPPLIER_NAME = "EXCESS Compute";
/** Owner decision, 16 September 2026: a listing never names who supplies it, and the name must not be readable from the
 * API either. The capability's own runtime is "openrouter" and is hashed into the pinned digest, so it cannot be renamed;
 * the public market listing carries this neutral value in its place instead. */
export const HOSTED_LISTING_RUNTIME = "hosted";
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

/** Smallest output budget a reasoning house model accepts, the same as local reasoning models (REASONING_MIN_OUTPUT_TOKENS).
 * On testnet on 15 September 2026, house gpt-oss-20b given 16 tokens reasoned until the budget ran out and answered nothing,
 * which fails the job while the prompt is still charged. */
export const HOSTED_REASONING_MIN_OUTPUT_TOKENS = 256;
/** How reasoning is requested: never offered, turned off, or kept (the model always reasons) with its text excluded from the
 * answer. Kept reasoning tokens are provider completion tokens and are billed as output tokens. */
export type HostedReasoning = "none" | "disabled" | "hidden" | "hidden_low";
/** Provider price ceiling in USD per million tokens. Every request carries it as OpenRouter provider.max_price. */
export interface ProviderPricing { readonly promptUsdPerM: string; readonly completionUsdPerM: string; readonly checkedAt: string }
export interface HostedModelEntry {
  readonly id: string; readonly displayName: string; readonly hosting: "house"; readonly info: ModelInfo;
  /** The supplier catalog model whose market this house model joins (one market per model, 19 September 2026): house supply
   * and independent suppliers then compete on that one listing, and `id` stays accepted as another name for it. Outside
   * the capability, so its digest is unchanged. Absent for a model that only EXCESS supplies. */
  readonly market?: string;
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
    ...(entry.reasoning === "hidden" || entry.reasoning === "hidden_low" ? { minOutputTokens: HOSTED_REASONING_MIN_OUTPUT_TOKENS } : {}),
  });
  const reasoning = entry.reasoning === "hidden" || entry.reasoning === "hidden_low";
  const precision = entry.quantizations.includes("fp4") || entry.quantizations.includes("int4") ? "native low-bit or higher precision" : "FP8 or higher precision";
  return Object.freeze({ ...entry, hosting: "house" as const, provider: "openrouter" as const,
    quantizations: Object.freeze([...entry.quantizations]),
    providerPricing: Object.freeze({ promptUsdPerM: prompt, completionUsdPerM: completion, checkedAt: CHECKED_AT }),
    info: Object.freeze({ ...info, contextTokens: HOSTED_CONTEXT_TOKENS, format: "Hosted API (" + precision + ")",
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
  hosted({ id: "house-gpt-oss-120b", market: "gpt-oss-120b", displayName: "gpt-oss-120b", providerModel: "openai/gpt-oss-120b", prompt: "0.037", completion: "0.17",
    // gpt-oss is released with native MXFP4 expert weights.
    quantizations: Object.freeze(["fp4", ...FP8_OR_BETTER]), reasoning: "hidden_low",
    info: { publisher: "OpenAI", family: "gpt-oss", parametersB: 117, activeParametersB: 5.1, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("openai/gpt-oss-120b"),
      summary: "OpenAI's larger open-weight reasoning model, fast and inexpensive. It reasons at low effort first; the reasoning is billed but not shown.", released: "2025-08" } }),
  hosted({ id: "house-llama-3.3-70b", market: "llama-3.3-70b", displayName: "Llama 3.3 70B Instruct", providerModel: "meta-llama/llama-3.3-70b-instruct", prompt: "0.22", completion: "0.52",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Meta", family: "Llama 3.3", parametersB: 70, maxContextTokens: 131072, licence: "Llama 3.3 Community", sourceUrl: HF("meta-llama/Llama-3.3-70B-Instruct"),
      summary: "A dependable 70B dense multilingual chat model for everyday writing, summarising and question answering.", released: "2024-12" } }),
  hosted({ id: "house-qwen3-32b", market: "qwen3-32b", displayName: "Qwen3 32B", providerModel: "qwen/qwen3-32b", prompt: "0.14", completion: "0.57",
    quantizations: FP8_OR_BETTER, reasoning: "disabled",
    info: { publisher: "Alibaba Qwen", family: "Qwen3", parametersB: 32.8, maxContextTokens: 40960, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-32B"),
      summary: "Qwen's largest dense Qwen3 model: a fast, capable general assistant, served with thinking turned off.", released: "2025-04" } }),
  hosted({ id: "house-gemma-3-27b", displayName: "Gemma 3 27B", providerModel: "google/gemma-3-27b-it", prompt: "0.119", completion: "0.45",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Google", family: "Gemma 3", parametersB: 27, maxContextTokens: 131072, licence: "Gemma", sourceUrl: HF("google/gemma-3-27b-it"),
      summary: "Google's largest Gemma 3 model: a compact multilingual assistant with good reasoning for its size; served for text only.", released: "2025-03" } }),
  hosted({ id: "house-gpt-oss-20b", market: "gpt-oss-20b", displayName: "gpt-oss-20b", providerModel: "openai/gpt-oss-20b", prompt: "0.03", completion: "0.14",
    quantizations: Object.freeze(["fp4", ...FP8_OR_BETTER]), reasoning: "hidden_low",
    info: { publisher: "OpenAI", family: "gpt-oss", parametersB: 21, activeParametersB: 3.6, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("openai/gpt-oss-20b"),
      summary: "OpenAI's small open-weight reasoning model: the cheapest and fastest of these sizes. Low-effort reasoning is billed but not shown.", released: "2025-08" } }),
  // Smaller and mid-size models so every listed size has supply. Slugs and endpoint prices read from
  // openrouter.ai/api/v1/models on 16 September 2026. On 19 September 2026 four ceilings were raised to admit more
  // providers (Llama 3.1 8B: cloudflare, coreweave; Qwen3 30B-A3B: alibaba; Llama 4 Scout: novita; Gemma 3 27B above:
  // parasail, novita), so one provider's outage no longer withdraws the model. Each still sells at the one-unit floor
  // per token, above its ceiling plus the default margin, so buyer prices are unchanged. Qwen3 14B's only alternative
  // (alibaba, 0.91 per million output tokens) would double its output price and was left out.
  hosted({ id: "house-llama-3.1-8b", market: "llama-3.1-8b", displayName: "Llama 3.1 8B Instruct", providerModel: "meta-llama/llama-3.1-8b-instruct", prompt: "0.22", completion: "0.287",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Meta", family: "Llama 3.1", parametersB: 8, maxContextTokens: 131072, licence: "Llama 3.1 Community", sourceUrl: HF("meta-llama/Llama-3.1-8B-Instruct"),
      summary: "Meta's small Llama 3.1: quick, inexpensive and dependable for everyday text work.", released: "2024-07" } }),
  hosted({ id: "house-gemma-3-12b", displayName: "Gemma 3 12B", providerModel: "google/gemma-3-12b-it", prompt: "0.05", completion: "0.15",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Google", family: "Gemma 3", parametersB: 12, maxContextTokens: 131072, licence: "Gemma", sourceUrl: HF("google/gemma-3-12b-it"),
      summary: "A mid-size multilingual Gemma 3: capable for its cost, served for text only.", released: "2025-03" } }),
  hosted({ id: "house-qwen3-8b", market: "qwen3-8b", displayName: "Qwen3 8B", providerModel: "qwen/qwen3-8b", prompt: "0.117", completion: "0.455",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba", family: "Qwen3", parametersB: 8, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-8B"),
      summary: "A small Qwen3: multilingual and even-handed across general text tasks.", released: "2025-04" } }),
  hosted({ id: "house-qwen3-14b", market: "qwen3-14b", displayName: "Qwen3 14B", providerModel: "qwen/qwen3-14b", prompt: "0.12", completion: "0.24",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba", family: "Qwen3", parametersB: 14, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-14B"),
      summary: "Qwen3 at a mid size: noticeably stronger than the 8B while staying inexpensive.", released: "2025-04" } }),
  hosted({ id: "house-qwen3-30b-a3b", market: "qwen3-30b-a3b", displayName: "Qwen3 30B-A3B", providerModel: "qwen/qwen3-30b-a3b", prompt: "0.13", completion: "0.52",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba", family: "Qwen3", parametersB: 30, activeParametersB: 3, maxContextTokens: 131072, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-30B-A3B"),
      summary: "A mixture-of-experts Qwen3: 30B of weights with about 3B active per token, so it answers quickly.", released: "2025-04" } }),
  hosted({ id: "house-qwen3-coder-30b-a3b", market: "qwen3-coder-30b-a3b", displayName: "Qwen3 Coder 30B-A3B", providerModel: "qwen/qwen3-coder-30b-a3b-instruct", prompt: "0.07", completion: "0.28",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba", family: "Qwen3 Coder", parametersB: 30, activeParametersB: 3, maxContextTokens: 262144, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-Coder-30B-A3B-Instruct"),
      summary: "Qwen3 Coder tuned for programming, with a long context for whole files and repositories.", released: "2025-07" } }),
  // Added 19 September 2026 so the supplier catalog's Qwen3 30B-A3B Instruct 2507 has house supply. Endpoints read that day:
  // streamlake (0.04815/0.19305, unknown precision), dekallm and siliconflow (0.09/0.3), nebius (0.1/0.3), alibaba (0.13/0.52).
  hosted({ id: "house-qwen3-30b-a3b-instruct-2507", market: "qwen3-30b-a3b-instruct-2507", displayName: "Qwen3 30B-A3B Instruct 2507",
    providerModel: "qwen/qwen3-30b-a3b-instruct-2507", prompt: "0.09", completion: "0.3",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Alibaba", family: "Qwen3", parametersB: 30, activeParametersB: 3, maxContextTokens: 262144, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-30B-A3B-Instruct-2507"),
      summary: "The July 2025 update of Qwen3 30B-A3B: an instruct-only mixture-of-experts model that answers directly, quickly and well.", released: "2025-07" } }),
  hosted({ id: "house-mistral-small-3.2", displayName: "Mistral Small 3.2 24B", providerModel: "mistralai/mistral-small-3.2-24b-instruct", prompt: "0.0938", completion: "0.25",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Mistral AI", family: "Mistral Small", parametersB: 24, maxContextTokens: 256000, licence: "Apache-2.0", sourceUrl: HF("mistralai/Mistral-Small-3.2-24B-Instruct-2506"),
      summary: "Mistral's compact instruct model: a long context and good instruction following at low cost.", released: "2025-06" } }),
  hosted({ id: "house-llama-4-scout", displayName: "Llama 4 Scout", providerModel: "meta-llama/llama-4-scout", prompt: "0.18", completion: "0.59",
    quantizations: FP8_OR_BETTER, reasoning: "none",
    info: { publisher: "Meta", family: "Llama 4", parametersB: 109, activeParametersB: 17, maxContextTokens: 1310720, licence: "Llama 4 Community", sourceUrl: HF("meta-llama/Llama-4-Scout-17B-16E-Instruct"),
      summary: "Meta's mixture-of-experts Llama 4 with an unusually long context; served for text only.", released: "2025-04" } }),
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
 * ceil(providerUsdPerToken × (1 + credit fee) × (1 + margin) × 10^decimals / usdPerToken), at least one base unit, where
 * usdPerToken is the asset's USD rate ("1" for a USD stablecoin). Exact integer arithmetic. Buyers pay this net plus the
 * platform fee on top. */
export function houseUnitPrice(usdPerMillion: string, marginBps: number = HOUSE_MARGIN_BPS.default, decimals = 6, usdPerToken = "1"): bigint {
  const { numerator, scale } = decimal(usdPerMillion), rate = decimal(usdPerToken);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("Invalid asset decimals");
  if (rate.numerator <= 0n) throw new RangeError("Invalid USD rate");
  const top = numerator * BigInt(10000 + OPENROUTER_CREDIT_FEE_BPS) * BigInt(10000 + validMarginBps(marginBps)) * 10n ** BigInt(decimals) * rate.scale;
  const bottom = scale * 100_000_000n * 1_000_000n * rate.numerator;
  const units = (top + bottom - 1n) / bottom;
  return units < 1n ? 1n : units;
}
export interface HousePrices { inputNetUnits: bigint; outputNetUnits: bigint }
export const housePrices = (entry: HostedModelEntry, marginBps: number = HOUSE_MARGIN_BPS.default, decimals = 6, usdPerToken = "1"): HousePrices => ({
  inputNetUnits: houseUnitPrice(entry.providerPricing.promptUsdPerM, marginBps, decimals, usdPerToken),
  outputNetUnits: houseUnitPrice(entry.providerPricing.completionUsdPerM, marginBps, decimals, usdPerToken),
});
/** Worst-case provider cost of a job in USD, including the credit fee, as an exact fraction numerator / denominator. */
export function providerCostUsd(pricing: Pick<ProviderPricing, "promptUsdPerM" | "completionUsdPerM">, promptTokens: number, completionTokens: number): { numerator: bigint; denominator: bigint } {
  const p = decimal(pricing.promptUsdPerM), c = decimal(pricing.completionUsdPerM);
  const scale = p.scale > c.scale ? p.scale : c.scale;
  const tokens = (p.numerator * (scale / p.scale)) * BigInt(promptTokens) + (c.numerator * (scale / c.scale)) * BigInt(completionTokens);
  return { numerator: tokens * BigInt(10000 + OPENROUTER_CREDIT_FEE_BPS), denominator: scale * 1_000_000n * 10000n };
}
