/** Isolated native helpers have a separate bounded lifetime from each job. */
export const MAX_RUNTIME_HELPER_LIFETIME_MS = 600_000;

/** Track conservatively from just before helper launch; expiry at the job
 * deadline is insufficient because the helper may terminate at that instant. */
export function runtimeHelperCoversJobDeadline(startedAt: number, jobDeadline: number): boolean {
  return startedAt + MAX_RUNTIME_HELPER_LIFETIME_MS > jobDeadline;
}

/** Linux helpers receive a seconds limit. Keep the existing five-second
 * supervisor/reap allowance after the bounded job timeout. The CPU helper
 * combines a thread-scaled RLIMIT_CPU with a wall-clock alarm; the CUDA helper
 * uses its separately validated 605-second wall-clock supervisor. */
export function linuxRuntimeHelperTimeoutSeconds(timeoutMs: number): number {
  return Math.ceil(Math.min(MAX_RUNTIME_HELPER_LIFETIME_MS, timeoutMs) / 1000) + 5;
}

/** The Windows native helper validates an integer millisecond limit up to
 * 600000. Callers may ask for the per-job maximum, but never widen the helper. */
export function windowsRuntimeHelperTimeoutMilliseconds(timeoutMs: number): number {
  return Math.min(MAX_RUNTIME_HELPER_LIFETIME_MS, timeoutMs);
}
