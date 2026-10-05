import type { UpdateCheck } from "./update.js";

const INTENT_MAX_AGE_MS = 15 * 60 * 1000;
const releaseId = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?-[0-9a-f]{12}$/;

export type ControllerControlSnapshot = Readonly<{ mode: "run" | "drain" | "stop"; revision: string }>;
export type ControllerUpdatePlanOptions = Readonly<{
  autoUpdate: boolean;
  supervised: boolean;
  current: string | null;
  check(signal: AbortSignal): Promise<UpdateCheck>;
  /** Host-owned explicit-control generation. Internal controller teardown must not advance it. */
  readControl(signal: AbortSignal): Promise<ControllerControlSnapshot>;
  /** Host updater, called only after successful reap, cleanup, and final control-generation check. */
  install(signal: AbortSignal, expectedRevision: string): Promise<number | undefined>;
}>;
export type ControllerUpdateFinishInput = Readonly<{
  run: Readonly<{ code: number | null; cleaned: boolean }>;
  status: Readonly<{ reason?: string }> | null | undefined;
  signal: AbortSignal;
}>;
export interface ControllerUpdatePlan {
  readonly callbacks: Readonly<{
    check(signal: AbortSignal): Promise<UpdateCheck>;
    requestInstall(signal: AbortSignal): Promise<number>;
  }>;
  /** Called by the host only after `run.closed`; returns 75 to restart, 1 on install failure, or undefined to keep the normal exit. */
  finish(input: ControllerUpdateFinishInput): Promise<number | undefined>;
}

function isSnapshot(value: unknown): value is ControllerControlSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return Object.keys(snapshot).sort().join(",") === "mode,revision" &&
    ["run", "drain", "stop"].includes(String(snapshot.mode)) && typeof snapshot.revision === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshot.revision);
}
function isCheck(value: unknown, current: string): value is UpdateCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as Record<string, unknown>;
  if (Object.keys(check).sort().join(",") !== "available,checkedAt,current,latest" || check.current !== current ||
      typeof check.latest !== "string" || check.latest.length > 128 || !releaseId.test(check.latest) ||
      typeof check.available !== "boolean" || check.available !== (check.current !== check.latest) ||
      typeof check.checkedAt !== "string" || check.checkedAt.length > 32) return false;
  const time = Date.parse(check.checkedAt);
  return Number.isFinite(time) && new Date(time).toISOString() === check.checkedAt;
}

function createPlan(options: ControllerUpdatePlanOptions, now: () => number): ControllerUpdatePlan | undefined {
  const current = options.current;
  if (!options.autoUpdate || !options.supervised || typeof current !== "string" || !releaseId.test(current) ||
      typeof options.check !== "function" || typeof options.readControl !== "function" || typeof options.install !== "function") return undefined;

  let available: { at: number; revision: string } | undefined;
  let intent: { at: number; revision: string } | undefined;
  const callbacks = Object.freeze({
    async check(signal: AbortSignal): Promise<UpdateCheck> {
      if (signal.aborted) throw new Error("CONTROLLER_UPDATE_ABORTED");
      available = undefined; intent = undefined;
      const before = await options.readControl(signal);
      if (signal.aborted) throw new Error("CONTROLLER_UPDATE_ABORTED");
      if (!isSnapshot(before)) throw new Error("CONTROLLER_UPDATE_CONTROL_INVALID");
      const result = await options.check(signal);
      if (signal.aborted) throw new Error("CONTROLLER_UPDATE_ABORTED");
      const after = await options.readControl(signal);
      if (signal.aborted) throw new Error("CONTROLLER_UPDATE_ABORTED");
      if (!isSnapshot(after) || after.revision !== before.revision) return result;
      if (!isCheck(result, current)) throw new Error("CONTROLLER_UPDATE_CHECK_INVALID");
      const checkedAt = Date.parse(result.checkedAt), currentTime = now();
      if (currentTime - checkedAt > INTENT_MAX_AGE_MS || checkedAt > currentTime + 30_000) throw new Error("CONTROLLER_UPDATE_CHECK_STALE");
      if (result.available && after.mode === "run") available = { at: currentTime, revision: after.revision };
      return result;
    },
    async requestInstall(signal: AbortSignal): Promise<number> {
      const checked = available;
      const requestTime = now();
      if (signal.aborted || !checked || requestTime - checked.at < 0 || requestTime - checked.at > INTENT_MAX_AGE_MS) { available = undefined; return 1; }
      const snapshot = await options.readControl(signal);
      if (signal.aborted || !isSnapshot(snapshot) || snapshot.mode !== "run" || snapshot.revision !== checked.revision) {
        available = undefined; return 1;
      }
      intent = { at: requestTime, revision: checked.revision };
      available = undefined;
      return 0;
    },
  });

  return Object.freeze({ callbacks, async finish(input: ControllerUpdateFinishInput): Promise<number | undefined> {
    const requested = intent;
    intent = undefined;
    const finishTime = now();
    if (!requested || input.signal.aborted || input.run.cleaned !== true || input.run.code !== 0 || input.status?.reason !== "updated" ||
        finishTime - requested.at < 0 || finishTime - requested.at > INTENT_MAX_AGE_MS) return undefined;
    let snapshot: ControllerControlSnapshot;
    try { snapshot = await options.readControl(input.signal); } catch { return undefined; }
    if (input.signal.aborted || !isSnapshot(snapshot) || snapshot.revision !== requested.revision) return undefined;
    try {
      const result = await options.install(input.signal, requested.revision);
      if (input.signal.aborted) return 1;
      if (result === undefined) return undefined;
      return result === 0 ? 75 : 1;
    } catch { return 1; }
  } });
}

/** Host-only auto-update plan. It has no URL, installer command, or child-controlled update source. */
export function createControllerUpdatePlan(options: ControllerUpdatePlanOptions): ControllerUpdatePlan | undefined {
  return createPlan(options, Date.now);
}

/** Explicit clock seam for focused unit tests; production must use createControllerUpdatePlan. */
export function __testOnlyCreateControllerUpdatePlan(options: ControllerUpdatePlanOptions, now: () => number): ControllerUpdatePlan | undefined {
  return createPlan(options, now);
}
