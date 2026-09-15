/** Buyer-facing facts about a catalog model, shown on the approved-models list. Local text, media and house-supply
 * entries all carry the same shape so the market can list them side by side. Informational only: nothing here is part
 * of a capability digest, so correcting a description never changes what a supplier is approved to serve. */
export type Modality="text"|"embedding"|"image"|"transcription";
export interface ModelInfo {
  /** Organisation that trained and released the weights, e.g. "Alibaba Qwen", "OpenAI", "Google", "Meta". */
  readonly publisher:string;
  /** Model family, e.g. "Qwen3", "gpt-oss", "Gemma 3". */
  readonly family:string;
  /** One or two plain sentences on what the model is good at. */
  readonly summary:string;
  /** Total parameters in billions. */
  readonly parametersB:number;
  /** Parameters active per token for mixture-of-experts models, in billions. */
  readonly activeParametersB?:number;
  /** Context window EXCESS actually serves for this entry (prompt plus output), not the model's theoretical maximum. */
  readonly contextTokens:number;
  /** The model's native maximum context, when larger than what is served. */
  readonly maxContextTokens?:number;
  /** Licence name as published with the weights, e.g. "Apache-2.0", "MIT", "Llama 3.3 Community". */
  readonly licence:string;
  /** Model card URL. */
  readonly sourceUrl:string;
  /** How the weights are served, e.g. "GGUF Q4_K_M" or "Hosted API (FP8)". */
  readonly format:string;
  readonly modalities:readonly Modality[];
  /** True when the model produces reasoning tokens before its answer; they are billed as output tokens. */
  readonly reasoning:boolean;
  /** Release month, YYYY-MM. */
  readonly released?:string;
}
/** Who supplies an entry: independent suppliers running the pinned local files, or EXCESS house supply. */
export type Hosting="local"|"house";
