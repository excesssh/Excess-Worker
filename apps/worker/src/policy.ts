import os from "node:os";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { BACKENDS, DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG, type Backend } from "@excess/adapters";
import { TEXT_LIMITS } from "@excess/protocol";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** The supplier's local policy, including which catalog model to serve and on which backend. */
export type WorkerPolicy = { threads: number; maxMemoryMb: number; runSeconds: number; idleOnly: boolean; idleSeconds: number; model: string; backend: Backend };
export type ResourceObservation = { freeMemoryMb: number | null; idleSeconds: number | null };
// Qwen3-4B Q4_K_M with an 8,192-token context needs about 3 GB of resident memory on CPU.
// A 2,048-token answer at CPU speeds of a few tokens per second needs several
// minutes, so the default run time is the approved maximum rather than 60 seconds.
// Idle detection exists only on Windows desktops, so Linux workers (usually servers) default to running whenever allowed.
export const DEFAULT_WORKER_POLICY: Readonly<WorkerPolicy> = Object.freeze({ threads: 2, maxMemoryMb: 4096, runSeconds: TEXT_LIMITS.maxRunSeconds, idleOnly: process.platform === "win32", idleSeconds: 60, model: DEFAULT_MODEL_ID, backend: "cpu" });
/** Errors name the failing setting, so a supplier whose policy file is refused (and who keeps the previous policy) can fix it. */
export function parseWorkerPolicy(input: unknown): WorkerPolicy {
  function invalid(detail: string): never { throw Error("Invalid worker policy: " + detail); }
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("expected a JSON object");
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter(key => !Object.hasOwn(DEFAULT_WORKER_POLICY, key));
  if (unknown.length) invalid("unknown setting " + unknown.slice(0, 4).join(", ").slice(0, 120));
  const policy = { ...DEFAULT_WORKER_POLICY, ...value } as WorkerPolicy;
  const whole = (key: "threads" | "maxMemoryMb" | "runSeconds" | "idleSeconds", minimum: number, maximum: number) => {
    if (!Number.isInteger(policy[key]) || policy[key] < minimum || policy[key] > maximum) invalid(`${key} must be a whole number from ${minimum} to ${maximum}`);
  };
  whole("threads", 1, 64); whole("maxMemoryMb", 1024, 262144); whole("runSeconds", 1, TEXT_LIMITS.maxRunSeconds); whole("idleSeconds", 1, 3600);
  if (typeof policy.idleOnly !== "boolean") invalid("idleOnly must be true or false");
  // A text or media catalog model; GPU-only media models never run on the CPU backend.
  const entry = MODEL_CATALOG.find(item => item.id === policy.model) ?? MEDIA_CATALOG.find(item => item.id === policy.model);
  if (!entry) invalid("model must be a catalog model id");
  if (!BACKENDS.includes(policy.backend)) invalid("backend must be one of " + BACKENDS.join(", "));
  if ("gpuOnly" in entry && entry.gpuOnly && policy.backend === "cpu") invalid(`${entry.id} runs on a GPU only`);
  // Whether the memory cap covers the chosen model is checked by the adapter when it loads the model.
  return policy;
}
export async function readWorkerPolicy(stateDir: string): Promise<WorkerPolicy> {
  try {
    const text = await readPrivateText(join(resolve(stateDir), "policy.json"), 4096);
    if (Buffer.byteLength(text) > 4096) throw Error("Invalid worker policy: the file is larger than 4 KB");
    return parseWorkerPolicy(JSON.parse(text));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_WORKER_POLICY }; throw error; }
}
export async function writeWorkerPolicy(stateDir: string, input: unknown): Promise<WorkerPolicy> {
  const policy = parseWorkerPolicy(input);
  await mkdir(resolve(stateDir), { recursive: true });
  await atomicPrivateJson(join(resolve(stateDir), "policy.json"), policy);
  return policy;
}
export function policyDecision(policy: WorkerPolicy, observation: ResourceObservation, active = false): { allowed: boolean; reason: string; detail?: string } {
  if (policy.threads > os.availableParallelism()) return { allowed: false, reason: "cpu_threads_unavailable",
    detail: `the policy asks for ${policy.threads} threads; this machine reports ${os.availableParallelism()}` };
  if (observation.freeMemoryMb === null || !Number.isFinite(observation.freeMemoryMb) || observation.freeMemoryMb < 0) return { allowed: false, reason: "memory_observation_unavailable" };
  // Say what was needed and what was seen: a supplier whose machine is simply too small cannot tell that from the reason alone.
  const requiredMb = active ? 128 : policy.maxMemoryMb + 128;
  if (observation.freeMemoryMb < requiredMb) return { allowed: false, reason: "memory_headroom",
    detail: `needs ${requiredMb} MB free (maxMemoryMb ${policy.maxMemoryMb} plus 128 MB); the machine reports ${observation.freeMemoryMb} MB` };
  if (policy.idleOnly) {
    if (observation.idleSeconds === null || !Number.isFinite(observation.idleSeconds) || observation.idleSeconds < 0) return { allowed: false, reason: "idle_observation_unavailable" };
    if (observation.idleSeconds < policy.idleSeconds) return { allowed: false, reason: "user_active" };
  }
  return { allowed: true, reason: "policy_allows" };
}
