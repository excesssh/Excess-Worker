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
/** Whether a model fits this computer: on the CPU with 2 GB left for the system, or fully offloaded to the largest GPU.
 * These are estimates; the local probe decides. */
export function modelFit(entry: Pick<ServedModel, "minMemoryMb" | "minVramMb" | "gpuOnly">, hardware: Hardware) {
  const bestGpuMb = Math.max(0, ...hardware.gpus.map(gpu => gpu.memoryMb));
  const cpu = !entry.gpuOnly && hardware.memoryMb >= entry.minMemoryMb + 2048, gpu = bestGpuMb >= entry.minVramMb;
  return { fits: (gpu && cpu ? "gpu or cpu" : gpu ? "gpu" : cpu ? "cpu" : "no") as Fit,
    cpu: { needsMemoryMb: entry.minMemoryMb, fits: cpu }, gpu: { needsGpuMemoryMb: entry.minVramMb, fits: gpu } };
}
/** Catalog models ordered by what fits: models this computer can serve first (catalog order), then those too large. */
export function modelsByFit<T extends Pick<ServedModel, "id" | "minMemoryMb" | "minVramMb" | "gpuOnly">>(models: readonly T[], hardware: Hardware) {
  const rated = models.map(entry => ({ entry, fit: modelFit(entry, hardware) }));
  return [...rated.filter(item => item.fit.fits !== "no"), ...rated.filter(item => item.fit.fits === "no")];
}
