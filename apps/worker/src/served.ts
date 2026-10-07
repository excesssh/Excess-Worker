import { AdapterError, MEDIA_CATALOG, MODEL_CATALOG, createMediaAdapter, createTextAdapter, textProbeTokens, type Backend, type MediaAdapter, type TextAdapter } from "@excess/adapters";
import type { MediaKind } from "@excess/protocol";

/** The worker serves exactly one catalog model: a streamed text model or a buffered media model (ADR 0007). */
export type ServedKind = "text" | MediaKind;
export type ServedModel = {
  id: string; kind: ServedKind; displayName: string; parameters: string; quantization: string; capabilityDigest: string;
  model: string; runtime: string; engine: "llama.cpp" | "stable-diffusion.cpp"; meteringUnit: string;
  minMemoryMb: number; minVramMb: number; gpuOnly: boolean; downloadBytes: number; licence: string;
  /** Most tokens a successful local probe may generate: reasoning models need room to reach their answer. */
  probeMaxTokens: number; reasoning: boolean;
};
export type ServedAdapter = TextAdapter | MediaAdapter;
export function servedModel(id: string): ServedModel {
  const text = MODEL_CATALOG.find(entry => entry.id === id);
  if (text) return { id: text.id, kind: "text", displayName: text.displayName, parameters: text.parameters, quantization: text.quantization, capabilityDigest: text.capabilityDigest,
    model: text.capability.model, runtime: text.capability.runtime, engine: "llama.cpp", meteringUnit: "output_token",
    minMemoryMb: text.minMemoryMb, minVramMb: text.minVramMb, gpuOnly: false, downloadBytes: text.artifacts.reduce((sum, item) => sum + item.bytes, 0),
    probeMaxTokens: textProbeTokens(text), reasoning: text.info.reasoning, licence: text.info.licence };
  const media = MEDIA_CATALOG.find(entry => entry.id === id);
  if (media) return { id: media.id, kind: media.kind, displayName: media.displayName, parameters: media.parameters, quantization: media.quantization, capabilityDigest: media.capabilityDigest,
    model: media.capability.model, runtime: media.capability.runtime, engine: media.runtime, meteringUnit: media.capability.meteringUnit,
    minMemoryMb: media.minMemoryMb, minVramMb: media.minVramMb, gpuOnly: media.gpuOnly, downloadBytes: media.artifacts.reduce((sum, item) => sum + item.bytes, 0),
    probeMaxTokens: 0, reasoning: false, licence: media.info.licence };
  throw new AdapterError("UNKNOWN_MODEL");
}
export const servedModels = (): ServedModel[] => [...MODEL_CATALOG, ...MEDIA_CATALOG].map(entry => servedModel(entry.id));
/** Offers are whole base units per metering unit. Suppliers type a human price per this many units. */
export function priceUnit(kind: ServedKind): { perUnits: bigint; label: string; unit: string } {
  if (kind === "text") return { perUnits: 1_000_000n, label: "million output tokens", unit: "output token" };
  if (kind === "embedding") return { perUnits: 1_000_000n, label: "million input tokens", unit: "input token" };
  if (kind === "transcription") return { perUnits: 3600n, label: "audio hour", unit: "audio second" };
  return { perUnits: 1n, label: "image", unit: "image" };
}
export const isMediaAdapter = (adapter: ServedAdapter): adapter is MediaAdapter => typeof (adapter as MediaAdapter).check === "function";
export function createServedAdapter(installDir: string, policy: { threads: number; maxMemoryMb: number; maxGpuMemoryMb?: number; runSeconds: number; model: string; backend: Backend }): ServedAdapter {
  const options = { threads: policy.threads, maxMemoryMb: policy.maxMemoryMb, timeoutMs: policy.runSeconds * 1000, modelId: policy.model, backend: policy.backend };
  return servedModel(policy.model).kind === "text" ? createTextAdapter(installDir, { ...options, ...(policy.maxGpuMemoryMb===undefined?{}:{maxGpuMemoryMb:policy.maxGpuMemoryMb}) }) : createMediaAdapter(installDir, options);
}
