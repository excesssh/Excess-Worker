import os from "node:os";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { BACKENDS, DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG, type Backend } from "@excess/adapters";
import { TEXT_LIMITS } from "@excess/protocol";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** One weekly window in the machine's local time. `days` are 0 (Sunday) to 6; a window whose `to` is not after its `from`
 * runs past midnight into the next day. "24:00" ends at midnight. */
export type ScheduleWindow = { days: number[]; from: string; to: string };
/** The supplier's local policy, including which catalog model to serve and on which backend. An empty schedule means any
 * time; pauseOnBattery stops taking new jobs while a laptop runs on battery; autoUpdate lets a worker running as a Linux
 * user service install a newly published version by itself when idle. */
export type WorkerPolicy = { threads: number; maxMemoryMb: number; runSeconds: number; idleOnly: boolean; idleSeconds: number; model: string; backend: Backend;
  schedule: ScheduleWindow[]; pauseOnBattery: boolean; autoUpdate: boolean };
/** `onBattery` is null when there is no battery or its state is unknown. */
export type ResourceObservation = { freeMemoryMb: number | null; idleSeconds: number | null; onBattery?: boolean | null };
// Qwen3-4B Q4_K_M with an 8,192-token context needs about 3 GB of resident memory on CPU.
// A 2,048-token answer at CPU speeds of a few tokens per second needs several
// minutes, so the default run time is the approved maximum rather than 60 seconds.
// Idle detection exists only on Windows desktops, so Linux workers (usually servers) default to running whenever allowed.
export const DEFAULT_WORKER_POLICY: Readonly<WorkerPolicy> = Object.freeze({ threads: 2, maxMemoryMb: 4096, runSeconds: TEXT_LIMITS.maxRunSeconds, idleOnly: process.platform === "win32", idleSeconds: 60, model: DEFAULT_MODEL_ID, backend: "cpu",
  schedule: Object.freeze([]) as unknown as ScheduleWindow[], pauseOnBattery: true, autoUpdate: false });
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Whether `now` (local time) falls inside any window; an empty schedule is always open. */
export function withinSchedule(schedule: readonly ScheduleWindow[], now: Date): boolean {
  if (!schedule.length) return true;
  const day = now.getDay(), at = now.getHours() * 60 + now.getMinutes(), previous = (day + 6) % 7;
  return schedule.some(({ days, from, to }) => {
    const start = minutes(from), end = minutes(to);
    if (start < end) return days.includes(day) && at >= start && at < end;
    return (days.includes(day) && at >= start) || (days.includes(previous) && at < end);
  });
}
/** "mon-fri 22:00-07:00", "sat,sun 00:00-24:00" or "22:00-07:00" (every day) into schedule windows. */
export function parseScheduleSpec(specs: readonly string[]): ScheduleWindow[] {
  return specs.map(spec => {
    const match = /^(?:([a-z,-]+)\s+)?(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(spec.trim().toLowerCase());
    if (!match) throw Error(`Invalid schedule "${spec}": use [days] HH:MM-HH:MM, for example "mon-fri 22:00-07:00"`);
    const days = new Set<number>();
    for (const part of (match[1] ?? "sun-sat").split(",").filter(Boolean)) {
      const [first, last = first] = part.split("-"), a = DAY_NAMES.indexOf(first!.slice(0, 3)), b = DAY_NAMES.indexOf(last!.slice(0, 3));
      if (a < 0 || b < 0) throw Error(`Invalid schedule "${spec}": days are mon, tue, wed, thu, fri, sat, sun`);
      for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
    }
    return { days: [...days].sort(), from: match[2]!, to: match[3]! };
  });
}
export function describeSchedule(schedule: readonly ScheduleWindow[]): string {
  if (!schedule.length) return "any time";
  return schedule.map(({ days, from, to }) => (days.length === 7 ? "every day" : days.map(d => DAY_NAMES[d]).join(",")) + ` ${from}-${to}`).join("; ");
}
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
  if (typeof policy.pauseOnBattery !== "boolean") invalid("pauseOnBattery must be true or false");
  if (typeof policy.autoUpdate !== "boolean") invalid("autoUpdate must be true or false");
  if (!Array.isArray(policy.schedule) || policy.schedule.length > 14) invalid("schedule must be a list of at most 14 windows");
  for (const window of policy.schedule) {
    const item = window as Record<string, unknown>;
    if (!item || typeof item !== "object" || Object.keys(item).some(key => !["days", "from", "to"].includes(key))) invalid("each schedule window has days, from and to");
    if (!Array.isArray(item.days) || !item.days.length || item.days.some(d => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) ||
      new Set(item.days).size !== item.days.length) invalid("schedule days are distinct whole numbers from 0 (Sunday) to 6");
    if (typeof item.from !== "string" || typeof item.to !== "string" || !TIME.test(item.from) || !TIME.test(item.to) || item.from === "24:00" || item.from === item.to)
      invalid("schedule times are HH:MM, from before 24:00 and different from to");
  }
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
/** `residentMb` is memory the worker's own loaded runtime already holds. After the probe the runtime stays loaded, and
 * without this credit a model that needs half the machine blocked itself: on an 8 GB Debian droplet on 19 September 2026
 * Qwen3-4B held 3.6 GB, left 3.7 GB free and the worker refused every job for want of 6.2 GB. */
export function policyDecision(policy: WorkerPolicy, observation: ResourceObservation, active = false, residentMb = 0, now: Date = new Date()): { allowed: boolean; reason: string; detail?: string } {
  if (policy.threads > os.availableParallelism()) return { allowed: false, reason: "cpu_threads_unavailable",
    detail: `the policy asks for ${policy.threads} threads; this machine reports ${os.availableParallelism()}` };
  if (observation.freeMemoryMb === null || !Number.isFinite(observation.freeMemoryMb) || observation.freeMemoryMb < 0) return { allowed: false, reason: "memory_observation_unavailable" };
  // Say what was needed and what was seen: a supplier whose machine is simply too small cannot tell that from the reason alone.
  const held = Number.isSafeInteger(residentMb) && residentMb > 0 ? Math.min(residentMb, policy.maxMemoryMb) : 0;
  const requiredMb = active ? 128 : policy.maxMemoryMb - held + 128;
  if (observation.freeMemoryMb < requiredMb) return { allowed: false, reason: "memory_headroom",
    detail: `needs ${requiredMb} MB free (maxMemoryMb ${policy.maxMemoryMb} plus 128 MB` + (held ? `, less ${held} MB the loaded model already holds` : "") +
      `); the machine reports ${observation.freeMemoryMb} MB` };
  if (policy.idleOnly) {
    if (observation.idleSeconds === null || !Number.isFinite(observation.idleSeconds) || observation.idleSeconds < 0) return { allowed: false, reason: "idle_observation_unavailable" };
    if (observation.idleSeconds < policy.idleSeconds) return { allowed: false, reason: "user_active" };
  }
  // Schedule and battery only stop new work; a running job finishes (at most runSeconds).
  if (!active && policy.pauseOnBattery && observation.onBattery === true) return { allowed: false, reason: "on_battery" };
  if (!active && !withinSchedule(policy.schedule, now)) return { allowed: false, reason: "outside_schedule", detail: "runs " + describeSchedule(policy.schedule) + " (local time)" };
  return { allowed: true, reason: "policy_allows" };
}
