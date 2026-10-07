import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServedModel } from "./served.js";
const execute = promisify(execFile);

export type Hardware = { memoryMb: number; gpus: { name: string; memoryMb: number }[] };
/** System memory and NVIDIA GPU memory (nvidia-smi). Other GPUs are not measured, so they never count as a fit. */
export async function detectHardware(): Promise<Hardware> {
  let gpus: Hardware["gpus"] = [];
  try {
    const { stdout } = await execute("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, maxBuffer: 16384, windowsHide: true });
    gpus = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [name, memory] = line.split(",").map(part => part.trim());
      return { name: name ?? "unknown", memoryMb: Number(memory) || 0 };
    });
  } catch { /* No NVIDIA utility: GPU memory unknown. */ }
  return { memoryMb: Math.floor(os.totalmem() / 1048576), gpus };
}
export type Fit = "gpu" | "cpu" | "gpu or cpu" | "no";
export type ExecutionBackend = "cpu" | "cuda" | "vulkan";
export type ExecutionProfile = {
  backend: ExecutionBackend;
  selectable: boolean;
  implementation: "implemented" | "unsupported";
  evidenceRelease?: "0.1.0";
  verification: "verified_on_recorded_configuration" | "pending_hardware_evidence" | "not_established_by_catalogue_inventory" | "not_verified" | "not_applicable";
  minimumHostMemoryMb?: number;
  minimumGpuMemoryMb?: number;
  maximumGpuMemoryMb?: number;
  note?: string;
};
export type ModelExecutionProfiles = { cpu: ExecutionProfile; cuda: ExecutionProfile; vulkan: ExecutionProfile };
export type SelectableFit<T> = { entry: T; fit: ReturnType<typeof modelFit>; executionProfile: ExecutionProfile };
/** Legacy RAM/VRAM size estimates, including a 2 GB host reserve for CPU use.
 * Backend selection, isolation and measured execution are checked separately. */
export function modelFit(entry: Pick<ServedModel, "minMemoryMb" | "minVramMb" | "gpuOnly">, hardware: Hardware) {
  const bestGpuMb = Math.max(0, ...hardware.gpus.map(gpu => gpu.memoryMb));
  const cpu = !entry.gpuOnly && hardware.memoryMb >= entry.minMemoryMb + 2048, gpu = bestGpuMb >= entry.minVramMb;
  return { fits: (gpu && cpu ? "gpu or cpu" : gpu ? "gpu" : cpu ? "cpu" : "no") as Fit,
    cpu: { needsMemoryMb: entry.minMemoryMb, fits: cpu }, gpu: { needsGpuMemoryMb: entry.minVramMb, fits: gpu } };
}
/** Capability of one execution profile. This is separate from the estimated RAM/VRAM fit and from installation availability. */
export function executionProfile(entry: Pick<ServedModel, "id" | "gpuOnly" | "minMemoryMb" | "minVramMb">,
  backend: ExecutionBackend, platform: NodeJS.Platform = process.platform): ExecutionProfile {
  if (platform !== "win32" && platform !== "linux") return { backend, selectable: false, implementation: "unsupported", verification: "not_applicable", note: "No isolated worker profile is implemented for this operating system." };
  if (backend === "cpu") return entry.gpuOnly
    ? { backend, selectable: false, implementation: "unsupported", verification: "not_verified", note: "This catalogue model is GPU-only." }
    : { backend, selectable: true, implementation: "implemented", verification: "not_established_by_catalogue_inventory",
        minimumHostMemoryMb: entry.minMemoryMb };
  if (backend === "vulkan") return { backend, selectable: false, implementation: "unsupported", verification: "not_applicable",
    note: "Isolated Vulkan execution is refused." };
  const windows = platform === "win32", linux = platform === "linux";
  const selectable = linux || windows && entry.id === "qwen3-4b";
  return {
    backend, selectable, implementation: selectable ? "implemented" : "unsupported",
    verification: windows && entry.id === "qwen3-4b" ? "verified_on_recorded_configuration" : linux ? "pending_hardware_evidence" : "not_verified",
    ...(windows && entry.id === "qwen3-4b" ? { evidenceRelease: "0.1.0" as const } : {}),
    minimumHostMemoryMb: Math.max(entry.minMemoryMb, windows ? 6144 : 0),
    minimumGpuMemoryMb: Math.max(entry.minVramMb, windows ? 6144 : 0),
    ...(windows ? { maximumGpuMemoryMb: 32768 } : linux ? { maximumGpuMemoryMb: 131072 } : {}),
    ...(!selectable ? { note: windows ? "Windows CUDA selection is supported only for Qwen3 4B." : "No isolated CUDA execution profile is available on this operating system." } :
      windows ? { note: "Published 0.1.0 verified only on the recorded RTX 3070 Ti and driver 596.49 configuration; the GPU memory budget is capped at 32 GB." } :
      { note: "Linux CUDA selection is implemented in the Worker 0.2.0 candidate; hardware verification is pending. The published 0.1.0 Linux archive remains CPU-only." }),
  };
}
export function modelExecutionProfiles(entry: Pick<ServedModel, "id" | "gpuOnly" | "minMemoryMb" | "minVramMb">,
  platform: NodeJS.Platform = process.platform): ModelExecutionProfiles {
  return { cpu: executionProfile(entry, "cpu", platform), cuda: executionProfile(entry, "cuda", platform), vulkan: executionProfile(entry, "vulkan", platform) };
}
/** Catalog models ordered by the legacy memory-size estimate: estimated fits first, then estimated non-fits. */
export function modelsByFit<T extends Pick<ServedModel, "id" | "minMemoryMb" | "minVramMb" | "gpuOnly">>(models: readonly T[], hardware: Hardware) {
  const rated = models.map(entry => ({ entry, fit: modelFit(entry, hardware) }));
  return [...rated.filter(item => item.fit.fits !== "no"), ...rated.filter(item => item.fit.fits === "no")];
}
/** Models with at least one selectable backend whose memory-size estimate fits. This still does not prove execution. */
export function modelsBySelectableFit<T extends Pick<ServedModel, "id" | "kind" | "minMemoryMb" | "minVramMb" | "gpuOnly">>(
  models: readonly T[], hardware: Hardware, platform: NodeJS.Platform = process.platform): SelectableFit<T>[] {
  const bestGpuMb = Math.max(0, ...hardware.gpus.map(gpu => gpu.memoryMb));
  return modelsByFit(models, hardware).flatMap(({ entry, fit }) => {
    const profiles = modelExecutionProfiles(entry, platform);
    const gpuFitsProfile = fit.gpu.fits && profiles.cuda.selectable && hardware.memoryMb - 2048 >= (profiles.cuda.minimumHostMemoryMb ?? 0) && bestGpuMb >= (profiles.cuda.minimumGpuMemoryMb ?? fit.gpu.needsGpuMemoryMb);
    const cpuFitsProfile = fit.cpu.fits && profiles.cpu.selectable && hardware.memoryMb >= (profiles.cpu.minimumHostMemoryMb ?? fit.cpu.needsMemoryMb);
    const choices = [
      ...(gpuFitsProfile ? [profiles.cuda] : []),
      ...(cpuFitsProfile ? [profiles.cpu] : []),
    ];
    const selected = choices.find(profile => profile.verification === "verified_on_recorded_configuration") ??
      choices.find(profile => profile.backend === "cpu") ?? choices[0];
    return selected ? [{ entry, fit, executionProfile: selected }] : [];
  });
}
/** Largest text entry whose estimate fits a profile this CLI can select on this platform. */
export function largestSelectableTextModel<T extends Pick<ServedModel, "id" | "kind" | "minMemoryMb" | "minVramMb" | "gpuOnly">>(
  models: readonly T[], hardware: Hardware, platform: NodeJS.Platform = process.platform) {
  return modelsBySelectableFit(models, hardware, platform).filter(item => item.entry.kind === "text")
    .reduce<SelectableFit<T> | undefined>((best, item) => !best || item.entry.minMemoryMb > best.entry.minMemoryMb ? item : best, undefined);
}
/** Add explicit installation-plan availability and execution-profile state without conflating either with memory fit. */
export function modelPlanStatus(entry: Pick<ServedModel, "id" | "gpuOnly" | "minMemoryMb" | "minVramMb">,
  backend: ExecutionBackend, platform: NodeJS.Platform, requiresExplicitConsent: boolean, diskSufficient: boolean | null) {
  return {
    installationAvailability: { planAvailable: true, requiresExplicitConsent,
      disk: diskSufficient === null ? "unknown" as const : diskSufficient ? "sufficient" as const : "insufficient" as const },
    executionProfile: executionProfile(entry, backend, platform),
  };
}

