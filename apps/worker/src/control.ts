import { constants, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterProbe } from "@excess/adapters";
import type { WorkerPolicy } from "./policy.js";
import type { WorkerStateWriter } from "./controller-state.js";

export type StateWriteContext = { readonly stateDir: string; readonly writer: WorkerStateWriter };
export function stateWriteName(context: StateWriteContext, path: string): string {
  const name = relative(resolve(context.stateDir), resolve(path)).split(sep).join("/");
  if (!name || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") || name.includes("\\")) throw Error("CONTROLLER_STATE_PATH_INVALID");
  return name;
}

export type WorkerMode = "run" | "drain" | "stop";
export type WorkerProbe = AdapterProbe & { policy: WorkerPolicy };
export type WorkerStatus = {
  version: 1; state: string; reason: string; updatedAt: string;
  deviceId?: string; activeAttemptId?: string | null; capabilityDigest?: string | null;
  // Historical observation from the current run, not a live-capacity flag.
  lastProbe?: WorkerProbe;
  // The last check of the paired exchange for a newer published worker.
  update?: { current: string | null; latest: string; available: boolean; checkedAt: string; installFailed?: true };
};
const privateFileOperations = new Map<string, Promise<unknown>>();
async function withPrivateFile<T>(path: string, action: () => Promise<T>): Promise<T> {
  const canonical = resolve(path);
  const operation = (privateFileOperations.get(canonical) ?? Promise.resolve()).catch(() => {}).then(action);
  privateFileOperations.set(canonical, operation);
  try { return await operation; }
  finally { if (privateFileOperations.get(canonical) === operation) privateFileOperations.delete(canonical); }
}
export async function readPrivateText(path: string, maximumBytes: number): Promise<string> {
  return withPrivateFile(path, async () => {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > maximumBytes) throw Error("Worker state file exceeds limit");
    return text;
  });
}
export async function atomicPrivateJson(path: string, value: unknown, context?: StateWriteContext): Promise<void> {
  if (context) {
    await context.writer.replace(stateWriteName(context, path), Buffer.from(JSON.stringify(value) + "\n"));
    return;
  }
  return withPrivateFile(path, () => writePrivateJson(path, value));
}
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = path + ".pending-" + randomUUID();
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  try {
    // Windows readers, indexers and antivirus can temporarily deny replacement.
    // Retry the same atomic rename; never delete/truncate the existing target.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 15 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, 10 * 2 ** attempt)));
      }
    }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function setWorkerControl(stateDir: string, mode: WorkerMode): Promise<void> {
  if (!["run", "drain", "stop"].includes(mode)) throw Error("Invalid worker control");
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  await controlTransaction(stateDir, async () => {
    // Keep control.json compatible with existing workers. The host-only request
    // revision invalidates a pending update even if stop and resume race.
    await writePrivateJson(join(resolve(stateDir), "control-request.json"), { version: 1, revision: randomUUID(), mode });
    const path = join(resolve(stateDir), "control.json");
    await withPrivateFile(path, () => writePrivateJson(path, { version: 1, mode }));
  });
}

/** Teardown records stopped state without inventing another user request. */
export async function stopWorkerControlAfterReap(stateDir: string): Promise<void> {
  await controlTransaction(stateDir, async () => {
    const path = join(resolve(stateDir), "control.json");
    await withPrivateFile(path, () => writePrivateJson(path, { version: 1, mode: "stop" }));
  });
}

async function controlTransaction<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(resolve(stateDir), "control-write.lock");
  return withPrivateFile(lockPath, async () => {
    const deadline = Date.now() + 5000;
    let lock;
    for (;;) {
      try {
        const created = await open(lockPath, "wx", 0o600);
        try { await created.writeFile(JSON.stringify({ pid: process.pid }) + "\n"); await created.sync(); lock = created; break; }
        catch (error) { await created.close(); await unlink(lockPath).catch(() => {}); throw error; }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Empty lock files can be observed while their owner writes its PID.
        // Malformed or live ownership is never removed to obtain a lock.
        const ownerFile = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
        });
        if (ownerFile) {
          try {
            const info = await ownerFile.stat();
            if (!info.isFile() || info.size > 128 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw Error("CONTROL_LOCK_INVALID");
            const text = await ownerFile.readFile("utf8");
            if (text) {
              const owner = JSON.parse(text) as { pid?: unknown };
              if (Object.keys(owner).join(",") !== "pid" || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) throw Error("CONTROL_LOCK_INVALID");
              if (!processAlive(owner.pid)) {
                const current = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
                if (current) { try { const present = await current.stat(); if (present.dev === info.dev && present.ino === info.ino) await unlink(lockPath); } finally { await current.close(); } }
              }
            }
          } finally { await ownerFile.close(); }
        }
        if (Date.now() >= deadline) throw Error("CONTROL_LOCK_UNAVAILABLE");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); }
    finally { await lock.close(); await unlink(lockPath); }
  });
}

/** Host observation only. Legacy controls can run, but cannot approve updates. */
export async function readWorkerControlRequest(stateDir: string): Promise<{ mode: WorkerMode; revision: string }> {
  return controlTransaction(stateDir, async () => {
    const mode = await readWorkerControl(stateDir);
    const request = await controlRequest(stateDir);
    return { mode, revision: request.revision };
  });
}

async function controlRequest(stateDir: string): Promise<{ mode: WorkerMode; revision: string }> {
    const file = await open(join(resolve(stateDir), "control-request.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 256 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw Error("CONTROL_REQUEST_INVALID");
      const value = JSON.parse(await file.readFile("utf8")) as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "mode,revision,version" || value.version !== 1 || !["run", "drain", "stop"].includes(String(value.mode)) ||
          typeof value.revision !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.revision)) throw Error("CONTROL_REQUEST_INVALID");
      return { mode: value.mode as WorkerMode, revision: value.revision };
    } finally { await file.close(); }
}

/** Linearize installation with explicit control requests. Release the request
 * lock immediately after invoking the installer; a download never blocks stop.
 * A later request observes an installation that has already begun. */
export async function startWorkerUpdate(stateDir: string, revision: string, start: () => Promise<number>): Promise<number | undefined> {
  const started = await controlTransaction(stateDir, async () => {
    const request = await controlRequest(stateDir);
    if (request.revision !== revision || request.mode !== "run") return undefined;
    await writePrivateJson(join(resolve(stateDir), "control-update.json"), { version: 1, revision, phase: "started" });
    return { task: start() };
  });
  return started?.task;
}
export async function readWorkerControl(stateDir: string): Promise<WorkerMode> {
  let text: string;
  try { text = await readPrivateText(join(resolve(stateDir), "control.json"), 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "stop"; throw error; }
  if (Buffer.byteLength(text) > 1024) throw Error("Invalid worker control");
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.version !== 1 || !["run", "drain", "stop"].includes(String(value.mode)) || Object.keys(value).some(k => !["version", "mode"].includes(k))) throw Error("Invalid worker control");
  return value.mode as WorkerMode;
}
export async function writeWorkerStatus(stateDir: string, status: Omit<WorkerStatus, "version" | "updatedAt">, context?: StateWriteContext): Promise<void> {
  await atomicPrivateJson(join(resolve(stateDir), "status.json"), { version: 1, ...status, updatedAt: new Date().toISOString() }, context);
}
export async function readWorkerStatus(stateDir: string): Promise<WorkerStatus> {
  let shutdownUnverified = false;
  try {
    const owner = JSON.parse(await readPrivateText(join(resolve(stateDir), "runtime.lock"), 1024)) as { shutdownUnverified?: unknown };
    shutdownUnverified = owner.shutdownUnverified !== undefined && owner.shutdownUnverified !== false;
  } catch { /* Lock acquisition separately refuses malformed ownership files. */ }
  try {
    const text = await readPrivateText(join(resolve(stateDir), "status.json"), 16384);
    if (Buffer.byteLength(text) > 16384) throw Error("Invalid worker status");
    const status = JSON.parse(text) as WorkerStatus;
    if (shutdownUnverified) return { ...status, state: "error", reason: "adapter_stop_failed", activeAttemptId: null, capabilityDigest: null };
    if (!["stopped", "revoked", "error"].includes(status.state)) {
      let alive = false;
      try { const owner = JSON.parse(await readPrivateText(join(resolve(stateDir), "runtime.lock"), 1024)) as { pid: number }; alive = processAlive(owner.pid); }
      catch { /* Missing/unreadable owner cannot substantiate a running worker. */ }
      if (!alive || Date.now() - Date.parse(status.updatedAt) > 30000) return { ...status, state: "stale", reason: "runtime_not_observed" };
    }
    return status;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, state: shutdownUnverified ? "error" : "stopped",
      reason: shutdownUnverified ? "adapter_stop_failed" : "not_started", updatedAt: new Date().toISOString(), ...(shutdownUnverified ? { capabilityDigest: null } : {}) };
    throw error;
  }
}
function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw Error("Worker lock requires inspection");
  try { process.kill(Number(pid), 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
  // On Linux a killed worker whose parent has not reaped it yet stays a zombie that still answers signal 0. It holds
  // nothing, so it must not keep the lock (found in the failover rehearsal, where the parent was itself stopped).
  if (process.platform === "linux") {
    try { const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"; }
    catch { return true; }
  }
  return true;
}
async function withRuntimeGuard<T>(stateDir: string, action: () => Promise<T>, retainOnFailure = false): Promise<T> {
  const path = join(resolve(stateDir), "runtime.guard");
  let guard;
  for (let n = 0; n < 20; n++) {
    try { guard = await open(path, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!guard) throw Error("Worker lock guard requires inspection");
  let succeeded = false;
  try { const result = await action(); succeeded = true; return result; }
  finally { await guard.close(); if (succeeded || !retainOnFailure) await unlink(path); }
}
export class WorkerShutdownError extends Error {
  readonly code = "ADAPTER_STOP_FAILED";
  constructor(cause: unknown) { super("Adapter shutdown unverified; local inspection required", { cause }); this.name = "WorkerShutdownError"; }
}
export type RuntimeLock = (() => Promise<void>) & { markShutdownUnverified(): Promise<void> };
export async function acquireRuntimeLock(stateDir: string): Promise<RuntimeLock> {
  await mkdir(resolve(stateDir), { recursive: true });
  const path = join(resolve(stateDir), "runtime.lock");
  const nonce = randomUUID();
  const handle = await withRuntimeGuard(stateDir, () => withPrivateFile(path, async () => {
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const text = await readFile(path, "utf8");
      if (text.length > 1024) throw Error("Worker lock requires inspection");
      const owner = JSON.parse(text) as { pid?: unknown; shutdownUnverified?: unknown };
      if (owner.shutdownUnverified !== undefined && owner.shutdownUnverified !== false) throw Error("Worker shutdown unverified; local inspection required");
      if (processAlive(owner.pid)) throw Error("Worker is already running");
      await unlink(path);
      file = await open(path, "wx", 0o600);
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.sync(); return file; }
    catch (error) { await file.close(); throw error; }
  }));
  let handleClosed = false, marked: Promise<void> | undefined;
  const closeHandle = async () => { if (!handleClosed) { await handle.close(); handleClosed = true; } };
  const release = async () => withRuntimeGuard(stateDir, () => withPrivateFile(path, async () => {
    const owner = JSON.parse(await readFile(path, "utf8")) as { nonce?: unknown; shutdownUnverified?: unknown };
    if (owner.nonce !== nonce) throw Error("Worker lock ownership changed");
    if (owner.shutdownUnverified !== undefined && owner.shutdownUnverified !== false) throw Error("Worker shutdown unverified; local inspection required");
    await closeHandle(); await unlink(path);
  }));
  return Object.assign(release, { markShutdownUnverified: () => marked ??= withRuntimeGuard(stateDir, () => withPrivateFile(path, async () => {
    try {
      const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; nonce?: unknown };
      if (owner.nonce !== nonce || owner.pid !== process.pid) throw Error("Worker lock ownership changed");
      const bytes = Buffer.from(JSON.stringify({ pid: process.pid, nonce, shutdownUnverified: true, shutdownUnverifiedAt: new Date().toISOString() }));
      // The guard excludes every acquisition/reclamation while this small marker
      // is rewritten. A torn write stays malformed and requires inspection.
      await handle.truncate(0);
      for (let offset = 0; offset < bytes.length;) {
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (result.bytesWritten < 1) throw Error("Worker lock marker write failed");
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally { await closeHandle(); }
  }), true).finally(closeHandle) });
}
