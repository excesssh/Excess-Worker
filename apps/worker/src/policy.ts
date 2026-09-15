import os from "node:os";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { BACKENDS, DEFAULT_MODEL_ID, MODEL_CATALOG, type Backend } from "@excess/adapters";
import { TEXT_LIMITS } from "@excess/protocol";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** The supplier's local policy, including which catalog model to serve and on which backend. */
export type WorkerPolicy = { threads: number; maxMemoryMb: number; runSeconds: number; idleOnly: boolean; idleSeconds: number; model: string; backend: Backend };
export type ResourceObservation = { freeMemoryMb: number | null; idleSeconds: number | null };
// Qwen3-4B Q4_K_M with an 8,192-token context needs about 3 GB of resident memory on CPU.
// A 2,048-token answer at CPU speeds of a few tokens per second needs several
// minutes, so the default run time is the approved maximum rather than 60 seconds.
export const DEFAULT_WORKER_POLICY: Readonly<WorkerPolicy> = Object.freeze({ threads: 2, maxMemoryMb: 4096, runSeconds: TEXT_LIMITS.maxRunSeconds, idleOnly: true, idleSeconds: 60, model: DEFAULT_MODEL_ID, backend: "cpu" });
export function parseWorkerPolicy(input: unknown): WorkerPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker policy");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_WORKER_POLICY, key))) throw Error("Invalid worker policy");
  const policy = { ...DEFAULT_WORKER_POLICY, ...value } as WorkerPolicy;
  const entry = MODEL_CATALOG.find(item => item.id === policy.model);
  if (!Number.isInteger(policy.threads) || policy.threads < 1 || policy.threads > 64 ||
      !Number.isInteger(policy.maxMemoryMb) || policy.maxMemoryMb < 1024 || policy.maxMemoryMb > 262144 ||
      !Number.isInteger(policy.runSeconds) || policy.runSeconds < 1 || policy.runSeconds > TEXT_LIMITS.maxRunSeconds ||
      typeof policy.idleOnly !== "boolean" || !Number.isInteger(policy.idleSeconds) || policy.idleSeconds < 1 || policy.idleSeconds > 3600 ||
      !entry || !BACKENDS.includes(policy.backend)) throw Error("Invalid worker policy");
  // Whether the memory cap covers the chosen model is checked by the adapter when it loads the model.
  return policy;
}
export async function readWorkerPolicy(stateDir: string): Promise<WorkerPolicy> {
  try {
    const text = await readPrivateText(join(resolve(stateDir), "policy.json"), 4096);
    if (Buffer.byteLength(text) > 4096) throw Error("Invalid worker policy");
    return parseWorkerPolicy(JSON.parse(text));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_WORKER_POLICY }; throw error; }
}
export async function writeWorkerPolicy(stateDir: string, input: unknown): Promise<WorkerPolicy> {
  const policy = parseWorkerPolicy(input);
  await mkdir(resolve(stateDir), { recursive: true });
  await atomicPrivateJson(join(resolve(stateDir), "policy.json"), policy);
  return policy;
}
export function policyDecision(policy: WorkerPolicy, observation: ResourceObservation, active = false): { allowed: boolean; reason: string } {
  if (policy.threads > os.availableParallelism()) return { allowed: false, reason: "cpu_threads_unavailable" };
  if (observation.freeMemoryMb === null || !Number.isFinite(observation.freeMemoryMb) || observation.freeMemoryMb < 0) return { allowed: false, reason: "memory_observation_unavailable" };
  if (observation.freeMemoryMb < (active ? 128 : policy.maxMemoryMb + 128)) return { allowed: false, reason: "memory_headroom" };
  if (policy.idleOnly) {
    if (observation.idleSeconds === null || !Number.isFinite(observation.idleSeconds) || observation.idleSeconds < 0) return { allowed: false, reason: "idle_observation_unavailable" };
    if (observation.idleSeconds < policy.idleSeconds) return { allowed: false, reason: "user_active" };
  }
  return { allowed: true, reason: "policy_allows" };
}
