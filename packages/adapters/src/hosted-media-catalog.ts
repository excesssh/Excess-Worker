import { MEDIA_LIMITS, requestDigest, type MediaKind } from "@excess/protocol";
import { MEDIA_CATALOG, type MediaModelEntry } from "./manifest.js";
import type { ModelInfo } from "./model-info.js";

/** EXCESS house supply for buffered media (ADR 0008 extended on 19 September 2026): embedding, speech-to-text and image
 * models the operator serves through OpenRouter's /embeddings, /audio/transcriptions and /images endpoints, listed beside the
 * supplier-hosted media catalog and sold under the same buffered protocol, limits and delivered-unit billing. Inputs leave
 * EXCESS for a hosted provider, so the trust class is provider_visible. */

/** What the exchange needs to list, quote, check and bill a media model, whoever serves it. */
export type MediaListing = Pick<MediaModelEntry, "id" | "kind" | "displayName" | "parameters" | "quantization" | "gpuOnly" | "minMemoryMb" | "minVramMb" |
  "capability" | "capabilityDigest" | "info"> & { readonly hosting?: "house" };
/** The listed OpenRouter rate a hosted media price was measured against: "prompt" is USD per input token or per audio second,
 * "image_output" USD per output image token; both as USD per million. A live rate above it withdraws the model. */
export interface HostedMediaPricing {
  /** USD per million billed units (input tokens, audio seconds or images) that the house price must cover. */
  readonly usdPerMillionUnits: string;
  readonly listedField: "prompt" | "image_output";
  readonly listedUsdPerM: string;
  readonly checkedAt: string;
}
export interface HostedMediaEntry extends MediaListing {
  readonly hosting: "house"; readonly provider: "openrouter"; readonly providerModel: string;
  /** The supplier catalog model whose market this house model joins, as for hosted text (HostedModelEntry.market). */
  readonly market?: string;
  readonly providerPricing: HostedMediaPricing;
  /** Request options: `dimensions` asks a Matryoshka embedding model for 1,024 values; image sizes are those the provider was
   * seen to honour exactly (a model that returns another size is only offered at the size it returns). */
  readonly options: { readonly dimensions?: number; readonly seed?: boolean };
}

type Input = { id: string; market?: string; kind: MediaKind; displayName: string; providerModel: string; usdPerMillionUnits: string; listedField: HostedMediaPricing["listedField"];
  listedUsdPerM: string; checkedAt: string; options?: HostedMediaEntry["options"]; sizes?: readonly number[];
  info: Omit<ModelInfo, "format" | "modalities" | "reasoning" | "contextTokens"> & { contextTokens?: number } };
const HF = (repository: string) => "https://huggingface.co/" + repository;
function hosted(input: Input): HostedMediaEntry {
  const { usdPerMillionUnits, listedField, listedUsdPerM, checkedAt, sizes, options, info, ...entry } = input;
  const meteringUnit = entry.kind === "embedding" ? "input_token" : entry.kind === "transcription" ? "audio_second" : "image";
  const limits = entry.kind === "embedding"
    ? { maxInputs: MEDIA_LIMITS.embedding.maxInputs, maxInputBytes: MEDIA_LIMITS.embedding.maxInputBytes, maxTotalBytes: MEDIA_LIMITS.embedding.maxTotalBytes,
      maxInputTokens: MEDIA_LIMITS.embedding.maxInputTokens, dimensions: MEDIA_LIMITS.embedding.dimensions, normalize: "euclidean" }
    : entry.kind === "transcription"
      ? { audioFormat: "wav-pcm16-mono-16khz", minSeconds: MEDIA_LIMITS.transcription.minSeconds, maxSeconds: MEDIA_LIMITS.transcription.maxSeconds,
        maxTranscriptBytes: MEDIA_LIMITS.transcription.maxTranscriptBytes }
      // A hosted model chooses its own sampling steps, so a request's steps must be 1 and are not forwarded.
      : { sizes: [...(sizes ?? [1024])], maxSteps: 1, steps: "provider_default", maxImages: MEDIA_LIMITS.image.maxImages,
        maxPromptBytes: MEDIA_LIMITS.image.maxPromptBytes, seed: options?.seed ? "forwarded" : "not_forwarded", format: "png" };
  // Prices stay outside the digest, as for hosted text: a refreshed snapshot changes offers, not what is approved.
  const capability = Object.freeze({
    version: 1, adapterId: "excess.hosted-media-" + entry.kind, adapterVersion: "0.1.0", kind: entry.kind, hosting: "house",
    runtime: "openrouter", provider: "openrouter", providerModel: entry.providerModel, modelId: entry.id, model: entry.displayName,
    meteringUnit, trustClass: "provider_visible", deliveryMode: "buffered", billingPolicy: "delivered_units_v1",
    ...(options?.dimensions ? { providerDimensions: options.dimensions } : {}), limits: Object.freeze(limits),
  });
  const contextTokens = info.contextTokens ?? (entry.kind === "embedding" ? 8192 : entry.kind === "image" ? 512 : 8192);
  return Object.freeze({
    ...entry, parameters: info.parametersB > 0 ? (info.parametersB >= 1 ? Number(info.parametersB.toFixed(1)) + "B" : Math.round(info.parametersB * 1000) + "M") : "Undisclosed",
    quantization: "Hosted API", gpuOnly: false, minMemoryMb: 0, minVramMb: 0, hosting: "house" as const, provider: "openrouter" as const,
    options: Object.freeze({ ...options }),
    providerPricing: Object.freeze({ usdPerMillionUnits, listedField, listedUsdPerM, checkedAt }),
    capability, capabilityDigest: requestDigest(capability),
    info: Object.freeze({ ...info, contextTokens, format: "Hosted API", modalities: Object.freeze([entry.kind] as const), reasoning: false }),
  }) as HostedMediaEntry;
}

/** The house media lineup. Endpoints, prices and behaviour were read from openrouter.ai on 19 September 2026 and each model
 * was called once live (evidence/2026-09-19-hosted-media.md): every embedding model returned 1,024 values, every speech
 * model transcribed a 7-second recording, and each image model returned a PNG of exactly the offered size. Image prices
 * are the measured cost of one image at the largest offered size; a model that ignored a smaller size is offered at 1,024
 * only. */
const CHECKED = "2026-09-19T00:00:00Z";
export const HOSTED_MEDIA_CATALOG: readonly HostedMediaEntry[] = Object.freeze([
  // ---------- Embeddings: USD per million input tokens ----------
  hosted({ id: "house-qwen3-embedding-8b", kind: "embedding", displayName: "Qwen3 Embedding 8B", providerModel: "qwen/qwen3-embedding-8b",
    usdPerMillionUnits: "0.04", listedField: "prompt", listedUsdPerM: "0.04", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "Alibaba Qwen", family: "Qwen3 Embedding", parametersB: 8, maxContextTokens: 32768, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-Embedding-8B"),
      summary: "Qwen's largest embedding model, multilingual and strong on retrieval benchmarks, returned as 1,024-dimension vectors.", released: "2025-06" } }),
  hosted({ id: "house-qwen3-embedding-4b", kind: "embedding", displayName: "Qwen3 Embedding 4B", providerModel: "qwen/qwen3-embedding-4b",
    usdPerMillionUnits: "0.02", listedField: "prompt", listedUsdPerM: "0.02", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "Alibaba Qwen", family: "Qwen3 Embedding", parametersB: 4, maxContextTokens: 32768, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-Embedding-4B"),
      summary: "A mid-size Qwen3 embedding model for multilingual search and clustering, returned as 1,024-dimension vectors.", released: "2025-06" } }),
  hosted({ id: "house-bge-m3", kind: "embedding", displayName: "BGE-M3", providerModel: "baai/bge-m3",
    usdPerMillionUnits: "0.01", listedField: "prompt", listedUsdPerM: "0.01", checkedAt: CHECKED,
    info: { publisher: "BAAI", family: "BGE", parametersB: 0.57, maxContextTokens: 8192, licence: "MIT", sourceUrl: HF("BAAI/bge-m3"),
      summary: "A widely used multilingual embedding model with native 1,024-dimension vectors and long-document support.", released: "2024-01" } }),
  hosted({ id: "house-text-embedding-3-small", kind: "embedding", displayName: "OpenAI text-embedding-3-small", providerModel: "openai/text-embedding-3-small",
    usdPerMillionUnits: "0.02", listedField: "prompt", listedUsdPerM: "0.02", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "OpenAI", family: "text-embedding-3", parametersB: 0, maxContextTokens: 8192, licence: "Proprietary (hosted API)",
      sourceUrl: "https://platform.openai.com/docs/guides/embeddings", summary: "OpenAI's small embedding model, shortened to 1,024 dimensions.", released: "2024-01" } }),
  hosted({ id: "house-text-embedding-3-large", kind: "embedding", displayName: "OpenAI text-embedding-3-large", providerModel: "openai/text-embedding-3-large",
    usdPerMillionUnits: "0.13", listedField: "prompt", listedUsdPerM: "0.13", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "OpenAI", family: "text-embedding-3", parametersB: 0, maxContextTokens: 8192, licence: "Proprietary (hosted API)",
      sourceUrl: "https://platform.openai.com/docs/guides/embeddings", summary: "OpenAI's most capable embedding model, shortened to 1,024 dimensions.", released: "2024-01" } }),
  hosted({ id: "house-mistral-embed", kind: "embedding", displayName: "Mistral Embed", providerModel: "mistralai/mistral-embed-2312",
    usdPerMillionUnits: "0.11", listedField: "prompt", listedUsdPerM: "0.11", checkedAt: CHECKED,
    info: { publisher: "Mistral AI", family: "Mistral Embed", parametersB: 0, maxContextTokens: 8192, licence: "Proprietary (hosted API)",
      sourceUrl: "https://docs.mistral.ai/capabilities/embeddings/", summary: "Mistral's general-purpose embedding model with native 1,024-dimension vectors.", released: "2023-12" } }),
  hosted({ id: "house-gemini-embedding-001", kind: "embedding", displayName: "Gemini Embedding 001", providerModel: "google/gemini-embedding-001",
    usdPerMillionUnits: "0.15", listedField: "prompt", listedUsdPerM: "0.15", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "Google", family: "Gemini Embedding", parametersB: 0, maxContextTokens: 20000, licence: "Proprietary (hosted API)",
      sourceUrl: "https://ai.google.dev/gemini-api/docs/embeddings", summary: "Google's multilingual embedding model, shortened to 1,024 dimensions and normalised by EXCESS.", released: "2025-07" } }),
  hosted({ id: "house-voyage-4", kind: "embedding", displayName: "Voyage 4", providerModel: "voyageai/voyage-4",
    usdPerMillionUnits: "0.06", listedField: "prompt", listedUsdPerM: "0.06", checkedAt: CHECKED, options: { dimensions: 1024 },
    info: { publisher: "Voyage AI", family: "Voyage 4", parametersB: 0, maxContextTokens: 32000, licence: "Proprietary (hosted API)",
      sourceUrl: "https://docs.voyageai.com/docs/embeddings", summary: "Voyage's general-purpose retrieval embedding model at 1,024 dimensions.", released: "2026-01" } }),

  // ---------- Speech to text: USD per million audio seconds ----------
  hosted({ id: "house-whisper-large-v3-turbo", kind: "transcription", displayName: "Whisper Large v3 Turbo", providerModel: "openai/whisper-large-v3-turbo",
    usdPerMillionUnits: "3.33", listedField: "prompt", listedUsdPerM: "3.33", checkedAt: CHECKED,
    info: { publisher: "OpenAI", family: "Whisper", parametersB: 0.81, licence: "MIT", sourceUrl: HF("openai/whisper-large-v3-turbo"),
      summary: "A fast, pruned Whisper Large v3 for multilingual speech to text.", released: "2024-10" } }),
  hosted({ id: "house-whisper-large-v3", kind: "transcription", displayName: "Whisper Large v3", providerModel: "openai/whisper-large-v3",
    usdPerMillionUnits: "7.5", listedField: "prompt", listedUsdPerM: "7.5", checkedAt: CHECKED,
    info: { publisher: "OpenAI", family: "Whisper", parametersB: 1.55, licence: "MIT", sourceUrl: HF("openai/whisper-large-v3"),
      summary: "OpenAI's full Whisper Large v3: accurate multilingual transcription.", released: "2023-11" } }),
  hosted({ id: "house-qwen3-asr-1.7b", kind: "transcription", displayName: "Qwen3 ASR 1.7B", providerModel: "qwen/qwen3-asr-1.7b",
    usdPerMillionUnits: "7.5", listedField: "prompt", listedUsdPerM: "7.5", checkedAt: CHECKED,
    info: { publisher: "Alibaba Qwen", family: "Qwen3-ASR", parametersB: 1.7, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-ASR-1.7B"),
      summary: "The larger Qwen3 speech recogniser: multilingual transcription with good accuracy on accents and noise.", released: "2026-01" } }),
  // Added 19 September 2026 so the supplier catalog's Qwen3 ASR 0.6B has house supply (one provider, deepinfra; it
  // transcribed the 7-second check recording correctly on 19 September 2026).
  hosted({ id: "house-qwen3-asr-0.6b", market: "qwen3-asr-0.6b", kind: "transcription", displayName: "Qwen3 ASR 0.6B", providerModel: "qwen/qwen3-asr-0.6b",
    usdPerMillionUnits: "3.33", listedField: "prompt", listedUsdPerM: "3.33", checkedAt: CHECKED,
    info: { publisher: "Alibaba Qwen", family: "Qwen3-ASR", parametersB: 0.6, licence: "Apache-2.0", sourceUrl: HF("Qwen/Qwen3-ASR-0.6B"),
      summary: "The small Qwen3 speech recogniser: fast multilingual transcription.", released: "2026-01" } }),
  hosted({ id: "house-parakeet-tdt-0.6b-v3", kind: "transcription", displayName: "Parakeet TDT 0.6B v3", providerModel: "nvidia/parakeet-tdt-0.6b-v3",
    usdPerMillionUnits: "25", listedField: "prompt", listedUsdPerM: "25", checkedAt: CHECKED,
    info: { publisher: "NVIDIA", family: "Parakeet", parametersB: 0.6, licence: "CC-BY-4.0", sourceUrl: HF("nvidia/parakeet-tdt-0.6b-v3"),
      summary: "NVIDIA's fast European-language speech recogniser with punctuation and capitalisation.", released: "2025-08" } }),
  hosted({ id: "house-voxtral-mini-transcribe", kind: "transcription", displayName: "Voxtral Mini Transcribe", providerModel: "mistralai/voxtral-mini-transcribe",
    usdPerMillionUnits: "55", listedField: "prompt", listedUsdPerM: "55", checkedAt: CHECKED,
    info: { publisher: "Mistral AI", family: "Voxtral", parametersB: 3, licence: "Apache-2.0", sourceUrl: HF("mistralai/Voxtral-Mini-3B-2507"),
      summary: "Mistral's transcription model built on Voxtral Mini, strong on multilingual speech.", released: "2025-07" } }),
  hosted({ id: "house-deepgram-nova-3", kind: "transcription", displayName: "Deepgram Nova-3", providerModel: "deepgram/nova-3",
    usdPerMillionUnits: "71.6666666667", listedField: "prompt", listedUsdPerM: "71.6666666667", checkedAt: CHECKED,
    info: { publisher: "Deepgram", family: "Nova", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://developers.deepgram.com/docs/models-languages-overview",
      summary: "Deepgram's production speech recogniser, accurate on noisy and conversational audio.", released: "2025-02" } }),

  // ---------- Images: USD per million images ----------
  hosted({ id: "house-flux.2-klein-4b", kind: "image", displayName: "FLUX.2 [klein] 4B", providerModel: "black-forest-labs/flux.2-klein-4b",
    usdPerMillionUnits: "14000", listedField: "image_output", listedUsdPerM: "3.41796875", checkedAt: CHECKED, sizes: [512, 768, 1024], options: { seed: true },
    info: { publisher: "Black Forest Labs", family: "FLUX.2", parametersB: 4, licence: "Apache-2.0", sourceUrl: HF("black-forest-labs/FLUX.2-klein-4B"),
      summary: "Black Forest Labs' small, fast FLUX.2 model: good prompt following at a low price per image.", released: "2026-01" } }),
  hosted({ id: "house-flux.2-pro", kind: "image", displayName: "FLUX.2 [pro]", providerModel: "black-forest-labs/flux.2-pro",
    usdPerMillionUnits: "30000", listedField: "image_output", listedUsdPerM: "7.32421875", checkedAt: CHECKED, sizes: [512, 768, 1024], options: { seed: true },
    info: { publisher: "Black Forest Labs", family: "FLUX.2", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://bfl.ai/models/flux-2",
      summary: "Black Forest Labs' high-quality FLUX.2 model for photographic detail, typography and complex scenes.", released: "2025-11" } }),
  hosted({ id: "house-krea-2-medium-turbo", kind: "image", displayName: "Krea 2 Medium Turbo", providerModel: "krea/krea-2-medium-turbo",
    usdPerMillionUnits: "15000", listedField: "image_output", listedUsdPerM: "3.59281437125749", checkedAt: CHECKED,
    info: { publisher: "Krea", family: "Krea 2", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://www.krea.ai",
      summary: "Krea's fast aesthetic image model; 1,024 × 1,024 only.", released: "2026-05" } }),
  hosted({ id: "house-qwen-image-3", kind: "image", displayName: "Qwen Image 3", providerModel: "qwen/qwen-image-3",
    usdPerMillionUnits: "30000", listedField: "image_output", listedUsdPerM: "7.18562874251497", checkedAt: CHECKED, options: { seed: true },
    info: { publisher: "Alibaba Qwen", family: "Qwen-Image", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://qwen.ai",
      summary: "Qwen's image model, strong at rendering text in images; slower, about a minute per image; 1,024 × 1,024 only.", released: "2026-06" } }),
  hosted({ id: "house-gemini-2.5-flash-image", kind: "image", displayName: "Gemini 2.5 Flash Image", providerModel: "google/gemini-2.5-flash-image",
    usdPerMillionUnits: "40000", listedField: "image_output", listedUsdPerM: "30", checkedAt: CHECKED, options: { seed: true },
    info: { publisher: "Google", family: "Gemini", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://ai.google.dev/gemini-api/docs/image-generation",
      summary: "Google's image model (\"Nano Banana\"): natural scenes and consistent characters; 1,024 × 1,024 only.", released: "2025-08" } }),
  hosted({ id: "house-gpt-image-1-mini", kind: "image", displayName: "GPT Image 1 Mini", providerModel: "openai/gpt-image-1-mini",
    usdPerMillionUnits: "36000", listedField: "image_output", listedUsdPerM: "8", checkedAt: CHECKED,
    info: { publisher: "OpenAI", family: "GPT Image", parametersB: 0, licence: "Proprietary (hosted API)", sourceUrl: "https://platform.openai.com/docs/guides/image-generation",
      summary: "OpenAI's lower-cost image model with strong prompt following; about 30 seconds per image; 1,024 × 1,024 only.", released: "2025-10" } }),
]);

export const hostedMediaEntry = (id: string): HostedMediaEntry | undefined => HOSTED_MEDIA_CATALOG.find(entry => entry.id === id);
export const hostedMediaEntryByDigest = (digest: string): HostedMediaEntry | undefined => HOSTED_MEDIA_CATALOG.find(entry => entry.capabilityDigest === digest);
export const isHostedMediaCapability = (digest: unknown): boolean => typeof digest === "string" && hostedMediaEntryByDigest(digest) !== undefined;
/** Every listable media model: the pinned supplier catalog, then house supply. */
export const MEDIA_LISTINGS: readonly MediaListing[] = Object.freeze([...MEDIA_CATALOG, ...HOSTED_MEDIA_CATALOG]);
export const mediaListingById = (id: string): MediaListing | undefined => MEDIA_LISTINGS.find(entry => entry.id === id);
/** The media model a capability digest names, local or hosted. */
export const mediaEntryByDigest = (digest: string): MediaListing | undefined => MEDIA_LISTINGS.find(entry => entry.capabilityDigest === digest);
export const isMediaCapability = (digest: unknown): boolean => typeof digest === "string" && mediaEntryByDigest(digest) !== undefined;
