import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createServedAdapter, isMediaAdapter, servedModel } from "./served.js";
import { createWorkerConnection } from "./identity.js";
import { acquireRuntimeLock, setWorkerControl, stopWorkerControlAfterReap, type RuntimeLock } from "./control.js";
import { parseCoordinatorOrigin } from "./egress-policy.js";
import { createControllerStateStore, type ControllerStateStore } from "./controller-state.js";
import { createWorkerStateReader, type WorkerStateReader } from "./controller-state-reader.js";
import { createWindowsStateHost, type WindowsStateHost } from "./windows-controller-state.js";
import { createWindowsAdapterHost, type WindowsAdapterHost } from "./windows-controller-adapter.js";
import { createWindowsCoordinatorHost } from "./windows-controller-coordinator.js";
import { checkForUpdate, currentRelease } from "./update.js";
import { createWindowsTextExecutionHost } from "./windows-controller-execution.js";
import { createWindowsExecutionProofStore } from "./windows-execution-proof-store.js";
import { createCoordinatorFetcher, __testOnlyCreateCoordinatorFetcher } from "./coordinator-fetch.js";
import { startWindowsController, type WindowsControllerPins, type WindowsControllerClosed } from "./windows-controller.js";
import { observeLocalResources } from "./telemetry.js";
import type { WorkerPolicy } from "./policy.js";

const execute = promisify(execFile);
const NODE_SHA256 = "f13ac3ca23248dc389507e8fe38c34489ab7edb3e6d6700eb6da6a0b7e128eaf";
async function noLinks(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root; let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw Error("CONTROLLER_STATE_INVALID");
  }
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  await noLinks(path); const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > limit) throw Error("CONTROLLER_PACKAGE_INVALID");
    const bytes = await file.readFile(); if (bytes.byteLength !== info.size || (await file.stat()).size !== info.size) throw Error("CONTROLLER_PACKAGE_CHANGED");
    return bytes;
  } finally { await file.close(); }
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function overlaps(left: string, right: string): boolean {
  const a = resolve(left).toLowerCase(), b = resolve(right).toLowerCase();
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
async function installedPins(packageDir: string): Promise<WindowsControllerPins> {
  const root = resolve(packageDir), native = join(root, "app/node_modules/@excess/adapters/native");
  const integrity = JSON.parse((await boundedFile(join(native, "integrity-controller-win32.json"), 16384)).toString("utf8")) as Record<string, unknown>;
  if (integrity.profile !== "windows-appcontainer-controller-v1" || typeof integrity.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(integrity.sha256)) throw Error("CONTROLLER_PINS_REQUIRED");
  return { packageInventorySha256: hash(await boundedFile(join(root, "SHA256SUMS.txt"), 1024 * 1024)), nodeSha256: NODE_SHA256,
    entrySha256: hash(await boundedFile(join(root, "app/worker/dist/windows-controller-entry.js"), 2 * 1024 * 1024)), helperSha256: integrity.sha256 };
}
async function protectState(stateDir: string): Promise<void> {
  if (!process.env.SystemRoot) throw Error("CONTROLLER_STATE_INVALID");
  await mkdir(stateDir, { recursive: true }); await noLinks(stateDir);
  // Preflight ownership, links and count before modifying descriptors. The host
  // controls this tree; no AppContainer or inherited public ACE is retained.
  const script = "$ErrorActionPreference='Stop';$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
    "$items=New-Object 'Collections.Generic.List[string]';$todo=New-Object 'Collections.Generic.Stack[string]';$todo.Push($env:EXCESS_PRIVATE_STATE);" +
    "while($todo.Count){$p=$todo.Pop();$attr=[IO.File]::GetAttributes($p);if(($attr -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'LINK'};" +
    "$dir=($attr -band [IO.FileAttributes]::Directory)-ne 0;$old=if($dir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};" +
    "if($old.GetOwner([Security.Principal.SecurityIdentifier]).Value-ne $u.Value){throw 'OWNER'};$items.Add($p);if($items.Count-gt 10000){throw 'COUNT'};" +
    "if($dir){foreach($n in [IO.Directory]::GetFileSystemEntries($p)){$todo.Push($n)}}};" +
    "foreach($p in $items){$dir=([IO.File]::GetAttributes($p)-band [IO.FileAttributes]::Directory)-ne 0;" +
    "$acl=if($dir){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity};" +
    "$acl.SetAccessRuleProtection($true,$false);foreach($sid in @($u.Value,'S-1-5-18','S-1-5-32-544')){" +
    "$identity=New-Object Security.Principal.SecurityIdentifier($sid);$inherit=if($dir){'ContainerInherit,ObjectInherit'}else{'None'};" +
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl',$inherit,'None','Allow');$acl.AddAccessRule($rule)};" +
    "if($dir){[IO.Directory]::SetAccessControl($p,$acl)}else{[IO.File]::SetAccessControl($p,$acl)}}";
  try {
    await execute(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 30000, maxBuffer: 4096, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, EXCESS_PRIVATE_STATE: stateDir },
    });
  } catch { throw Error("CONTROLLER_STATE_PRIVACY_UNAVAILABLE"); }
}

/** Admit only the pinned CUDA model with the independently tested host/GPU
 * budgets. Admission does not prove hardware: native probe validation still
 * requires monitored residency and all 37 layers before supply is advertised. */
export function validateWindowsControllerModelPolicy(policy: WorkerPolicy): void {
  if (policy.backend !== "cpu") {
    if (policy.backend !== "cuda" || policy.model !== "qwen3-4b") throw Error("CONTROLLER_GPU_PROFILE_UNVERIFIED");
    if (!Number.isSafeInteger(policy.maxMemoryMb) || policy.maxMemoryMb < 6144 ||
        !Number.isSafeInteger(policy.maxGpuMemoryMb) || policy.maxGpuMemoryMb < 6144) throw Error("CONTROLLER_GPU_MEMORY_BUDGET_REQUIRED");
  }
  if (servedModel(policy.model).kind !== "text") throw Error("CONTROLLER_MEDIA_PROFILE_UNVERIFIED");
}

export interface WindowsWorkerOptions { readonly packageDir: string; readonly stateDir: string; readonly installDir: string; readonly signal?: AbortSignal; }
/** Trusted bootstrap owns signing keys, host-PID ownership, store quotas and the
 * separately isolated native adapter. The Node controller receives typed data. */
export async function runWindowsWorker(options: WindowsWorkerOptions): Promise<WindowsControllerClosed> {
  return runWorkerWithTransport(options, createCoordinatorFetcher);
}
async function runWorkerWithTransport(options: WindowsWorkerOptions, fetchFactory: (origin: string) => typeof fetch): Promise<WindowsControllerClosed> {
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v24.11.1" || options.signal?.aborted) throw Error("CONTROLLER_ISOLATION_UNAVAILABLE");
  const packageDir = resolve(options.packageDir), stateDir = resolve(options.stateDir);
  if (overlaps(packageDir, stateDir) || overlaps(options.installDir, stateDir) || overlaps(packageDir, options.installDir)) throw Error("CONTROLLER_PATH_INVALID");
  const pins = await installedPins(packageDir);
  await protectState(stateDir);
  let lock: RuntimeLock | undefined, reader: WorkerStateReader | undefined, store: ControllerStateStore | undefined;
  let state: WindowsStateHost | undefined, adapter: WindowsAdapterHost | undefined;
  let coordinator: ReturnType<typeof createWindowsCoordinatorHost> | undefined;
  let execution: Awaited<ReturnType<typeof createWindowsTextExecutionHost>> | undefined;
  let proofStore: Awaited<ReturnType<typeof createWindowsExecutionProofStore>> | undefined;
  let connection: Awaited<ReturnType<typeof createWorkerConnection>> | undefined;
  let result: WindowsControllerClosed | undefined, shutdownUnverified = false, cleanupConfirmed = true;
  try {
    lock = await acquireRuntimeLock(stateDir);
    reader = await createWorkerStateReader({ stateDir }); const policy = await reader.readPolicy();
    validateWindowsControllerModelPolicy(policy);
    // The connection initializes and keeps its decrypted signing key only here.
    const identityBytes = await boundedFile(join(stateDir, "identity.json"), 16384);
    let origin: string;
    try {
      const identity = JSON.parse(identityBytes.toString("utf8")) as Record<string, unknown>;
      if (typeof identity.origin !== "string") throw Error();
      origin = parseCoordinatorOrigin(identity.origin).origin;
    } catch { throw Error("CONTROLLER_IDENTITY_INVALID"); }
    finally { identityBytes.fill(0); }
    const fetcher = fetchFactory(origin);
    connection = await createWorkerConnection(join(stateDir, "identity.json"), fetcher);
    if (connection.origin !== origin) throw Error("CONTROLLER_ORIGIN_MISMATCH");
    store = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => { shutdownUnverified = true; await lock!.markShutdownUnverified(); } });
    state = createWindowsStateHost(reader, store);
    const engine = createServedAdapter(options.installDir, policy); if (isMediaAdapter(engine)) throw Error("CONTROLLER_MEDIA_PROFILE_UNVERIFIED");
    adapter = createWindowsAdapterHost(engine, policy.runSeconds);
    const packagedRelease = await currentRelease();
    coordinator = createWindowsCoordinatorHost({ connection, capabilityDigest: servedModel(policy.model).capabilityDigest, fetcher, telemetry: observeLocalResources,
      update: { current: packagedRelease, check: (pairedOrigin, current, signal) => checkForUpdate(pairedOrigin, current, fetcher, signal) },
      readOffers: () => reader!.readOffers(policy.model) });
    proofStore = await createWindowsExecutionProofStore(stateDir);
    execution = await createWindowsTextExecutionHost({ coordinator, adapter, proofStore, deviceId: connection.deviceId,
      capabilityDigest: servedModel(policy.model).capabilityDigest, runSeconds: policy.runSeconds });
    const stateHost = state, executionHost = execution;
    await setWorkerControl(stateDir, "run");
    try {
      const run = await startWindowsController({ packageDir, stateDir, origin, pins, ...(options.signal ? { signal: options.signal } : {}),
        handleRequest: (request, signal) => request.op === "state" ? stateHost.handle(request.payload, signal)
          : request.op === "adapter" ? executionHost.handleAdapter(request.payload, signal) : executionHost.handleCoordinator(request.payload, signal) });
      result = await run.closed; cleanupConfirmed = result.reaped && result.cleaned;
    } catch (error) {
      cleanupConfirmed = !(error instanceof Error && ["CONTROLLER_CLEANUP_UNCONFIRMED", "CONTROLLER_STOP_UNCONFIRMED"].includes(error.message));
      throw error;
    }
  } finally {
    if (execution) {
      try { await execution.close(); } catch { cleanupConfirmed = false; }
    } else {
      try { await coordinator?.close(); } catch { cleanupConfirmed = false; }
      try { await adapter?.close(); } catch { cleanupConfirmed = false; }
    }
    try { await proofStore?.close(); } catch { cleanupConfirmed = false; }
    try { if (state) await state.close(); else await reader?.close(); } catch { cleanupConfirmed = false; }
    try { await store?.close(); } catch { cleanupConfirmed = false; }
    if (connection) await connection.heartbeat({ totalSlots: 1, availableSlots: 0, capabilityDigests: [] }, AbortSignal.timeout(2000)).catch(() => {});
    if (lock) {
      if (!cleanupConfirmed || shutdownUnverified) await lock.markShutdownUnverified().catch(() => {});
      else { await stopWorkerControlAfterReap(stateDir); await lock(); }
    }
  }
  if (!result || !cleanupConfirmed || shutdownUnverified) throw Error("CONTROLLER_CLEANUP_UNCONFIRMED");
  return result;
}

/** Explicit local TLS fixture only. It changes transport trust/DNS while keeping
 * production entry, AppContainer, package, native adapter and cleanup checks. */
export async function __testOnlyRunWindowsWorker(options: WindowsWorkerOptions,
  transport: { readonly ca: string | Buffer; readonly resolver: (hostname: string, signal: AbortSignal) => Promise<readonly string[]> }): Promise<WindowsControllerClosed> {
  return runWorkerWithTransport(options, origin => __testOnlyCreateCoordinatorFetcher({ origin, ca: transport.ca, resolver: transport.resolver }));
}
