import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { createEgressBroker, __testOnlyCreateEgressBroker, type EgressBroker, type EgressBrokerOptions } from "./egress-broker.js";
import { createLinuxEgressPeerValidator } from "./egress-peer.js";
import { parseCoordinatorOrigin } from "./egress-policy.js";
import { requireControllerBudget } from "./controller-budget.js";
import { verifyControllerPackage } from "./controller-integrity.js";
import { acquireRuntimeLock, setWorkerControl, stopWorkerControlAfterReap, type RuntimeLock } from "./control.js";
import { createControllerStateStore, createLinuxControllerStateBroker, type ControllerStateStore } from "./controller-state.js";
import { createHeartbeatSequenceReserve } from "./identity.js";
import type { UpdateCheck } from "./update.js";
import { readWorkerPolicy, type WorkerPolicy } from "./policy.js";
import { servedModel } from "./served.js";

const PROFILE = "linux-controller-namespaces-v1";
const NODE_VERSION = "v24.11.1";
const SAFE_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;

/** Admission is distinct from execution verification. The CUDA helper still
 * requires its exact pin, kernel cgroup files, one NVIDIA device and NVML. */
export function validateLinuxControllerModelPolicy(policy: WorkerPolicy): void {
  if (policy.backend === "cpu") return;
  if (policy.backend !== "cuda") throw Error("CONTROLLER_GPU_PROFILE_UNVERIFIED");
  const model = servedModel(policy.model);
  if (policy.maxGpuMemoryMb < model.minVramMb || policy.maxGpuMemoryMb > 131072 ||
      policy.maxMemoryMb < model.minMemoryMb || policy.maxMemoryMb > 129024)
    throw Error("CONTROLLER_GPU_MEMORY_BUDGET_REQUIRED");
}

export interface LinuxControllerOptions {
  /** Installed, authenticated immutable package root, including bundled Node. */
  readonly packageDir: string;
  /** Existing authenticated model/runtime store. Mounted read-only; never copied. */
  readonly installDir: string;
  /** Only mutable worker state. It cannot contain the package or helper policy. */
  readonly stateDir: string;
  /** Paired HTTPS origin from trusted setup, outside controller-writable state. */
  readonly origin: string;
  readonly signal?: AbortSignal;
  /** Only trusted host callbacks; installation requests record intent until reap. */
  readonly updates?: { check(signal: AbortSignal): Promise<UpdateCheck>; requestInstall(signal: AbortSignal): Promise<number> };
}
export interface LinuxControllerRun {
  readonly namespace: { readonly dev: string; readonly ino: string };
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly cleaned: boolean }>;
  stop(): Promise<void>;
}

async function noLinks(path: string): Promise<void> {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of relative(root, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error("CONTROLLER_PATH_INVALID");
  }
}
function overlaps(first: string, second: string): boolean {
  const rel = relative(first, second);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith(sep));
}
async function privateDirectory(path: string): Promise<void> {
  await noLinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("CONTROLLER_STATE_INVALID");
}
async function pinHelper(path: string): Promise<FileHandle> {
  await noLinks(path);
  const before = await lstat(path);
  if (!before.isFile() || (before.uid !== process.getuid?.() && before.uid !== 0) || (before.mode & 0o022) || before.size < 1 || before.size > 16 * 1024 * 1024) throw Error("CONTROLLER_HELPER_INVALID");
  const pinPath = join(dirname(path), "integrity-controller.json");
  await noLinks(pinPath);
  const pinFile = await open(pinPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let pin: Record<string, unknown>;
  try {
    const info = await pinFile.stat();
    if (!info.isFile() || (info.uid !== process.getuid?.() && info.uid !== 0) || (info.mode & 0o022) || info.size < 1 || info.size > 4096) throw Error("CONTROLLER_HELPER_INVALID");
    pin = JSON.parse(await pinFile.readFile("utf8")) as Record<string, unknown>;
  } finally { await pinFile.close(); }
  if (!pin || Object.keys(pin).sort().join(",") !== "profile,sha256" || pin.profile !== PROFILE ||
      typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw Error("CONTROLLER_HELPER_INVALID");
  const helper = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await helper.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size || (info.mode & 0o022) ||
        createHash("sha256").update(await helper.readFile()).digest("hex") !== pin.sha256) throw Error("CONTROLLER_HELPER_INVALID");
    return helper;
  } catch (error) { await helper.close(); throw error; }
}
async function namespaceOf(pid: number): Promise<{ dev: string; ino: string }> {
  const info = await stat(`/proc/${pid}/ns/net`, { bigint: true });
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}
function waitClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolveClose => {
    child.once("error", () => undefined);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}
async function stopChild(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
  const bounded = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("CONTROLLER_STOP_UNCONFIRMED")), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  // The native supervisor forwards the graceful request to private PID1.
  // If it does not finish, supervisor death kills the entire PID namespace.
  child.kill("SIGTERM");
  try { await bounded(); } catch { child.kill("SIGKILL"); await bounded(); }
}

/** Trusted host bootstrap. The broker is outside the controller's writable
 * filesystem and private namespaces. Every setup failure aborts execution. */
export async function startLinuxController(options: LinuxControllerOptions): Promise<LinuxControllerRun> {
  return startController(options, createEgressBroker);
}

/** Explicit fixture-only TLS trust for a local coordinator. Namespace, package,
 * resource and native peer verification remain mandatory. The CLI never calls
 * this entry, and production DNS/trust policy cannot be changed by environment. */
export async function __testOnlyStartLinuxController(options: LinuxControllerOptions, fixture: {
  readonly ca: string | Buffer;
  readonly resolver: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
}): Promise<LinuxControllerRun> {
  return startController(options, brokerOptions => __testOnlyCreateEgressBroker({
    ...brokerOptions, ca: fixture.ca, resolver: fixture.resolver, allowLoopback: true,
  }));
}

async function startController(options: LinuxControllerOptions,
  brokerFactory: (options: EgressBrokerOptions) => Promise<EgressBroker>): Promise<LinuxControllerRun> {
  if (process.platform !== "linux" || process.arch !== "x64" || process.version !== NODE_VERSION || !process.getuid?.()) throw Error("CONTROLLER_ISOLATION_UNAVAILABLE");
  if (options.signal?.aborted) throw Error("CONTROLLER_CANCELLED");
  const policy = await readWorkerPolicy(options.stateDir);
  validateLinuxControllerModelPolicy(policy);
  const gpu = policy.backend === "cuda";
  await requireControllerBudget(gpu ? { maximumMemoryBytes: 128n*1024n**3n,
    minimumMemoryBytes: BigInt(policy.maxMemoryMb+2048)*1048576n } : undefined);
  const origin = parseCoordinatorOrigin(options.origin).origin;
  const packageDir = resolve(options.packageDir), installDir = resolve(options.installDir), stateDir = resolve(options.stateDir);
  if ([packageDir, installDir, stateDir].some(path => path === "/") || overlaps(stateDir, packageDir) || overlaps(packageDir, stateDir) ||
      overlaps(stateDir, installDir) || overlaps(installDir, stateDir) || overlaps(packageDir, installDir) || overlaps(installDir, packageDir)) throw Error("CONTROLLER_PATH_INVALID");
  await noLinks(packageDir); await noLinks(installDir); await privateDirectory(stateDir);
  await verifyControllerPackage(packageDir);
  for (const file of ["node/bin/node", "app/worker/dist/controller-entry.js"]) {
    const path = join(packageDir, file); await noLinks(path);
    if (!(await lstat(path)).isFile()) throw Error("CONTROLLER_PACKAGE_REQUIRED");
  }
  const nativeDir = join(packageDir, "app/node_modules/@excess/adapters/native");
  // Packaged dependency paths are real directories, never workspace symlinks.
  const helper = await pinHelper(join(nativeDir, "excess-controller"));
  let base: string | undefined, broker: EgressBroker | undefined, child: ChildProcess | undefined;
  let stateBroker: { close(): Promise<void> } | undefined, lock: RuntimeLock | undefined;
  let stateStore: ControllerStateStore | undefined;
  let shutdownUnverified = false;
  let expected: { readonly dev: string; readonly ino: string } | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let abort: (() => void) | undefined;
  let running = false;
  const validatePeer = (socket: Socket, signal?: AbortSignal) => expected ? createLinuxEgressPeerValidator({
    helperPath: join(nativeDir, "excess-egress-peer"), expectedControllerNamespace: expected })(socket, signal) : false;
  const cleanup = async (reaped: boolean): Promise<boolean> => {
    if (abort) options.signal?.removeEventListener("abort", abort);
    const results = await Promise.allSettled([broker?.close(), stateBroker?.close()]);
    let brokersClosed = results.every(result => result.status === "fulfilled");
    try { await stateStore?.close(); } catch { brokersClosed = false; }
    let removed = !base;
    try {
      if (base && reaped && brokersClosed && (await readdir(join(base, "root"))).length === 0) {
        await privateDirectory(base);
        await rm(base, { recursive: true, force: true }); removed = true;
      }
    } catch { removed = false; }
    if (lock) {
      await stopWorkerControlAfterReap(stateDir).catch(() => { removed = false; });
      if (!reaped) {
        shutdownUnverified = true;
        await lock.markShutdownUnverified().catch(() => {});
      }
      if (reaped && !shutdownUnverified) await lock().catch(() => { removed = false; });
    }
    return reaped && brokersClosed && removed;
  };
  try {
    lock = await acquireRuntimeLock(stateDir);
    const offersDir = join(stateDir, "offers");
    try {
      await noLinks(offersDir);
      const info = await lstat(offersDir);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw Error("CONTROLLER_STATE_INVALID");
      await chmod(offersDir, 0o700);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const store = stateStore = await createControllerStateStore({ stateDir, markShutdownUnverified: async () => {
      shutdownUnverified = true; await lock!.markShutdownUnverified();
    } });
    base = await mkdtemp(join(tmpdir(), "excess-controller-")); await chmod(base, 0o700);
    await privateDirectory(base);
    for (const part of ["root", "scratch", "broker", "state-broker"]) await mkdir(join(base, part), { mode: 0o700 });
    const socketPath = join(base, "broker", "socket");
    broker = await brokerFactory({ socketPath, origin, validatePeer });
    const stateSocket = join(base, "state-broker", "socket");
    let sequenceReserve: Promise<(signal?: AbortSignal) => Promise<number>> | undefined;
    stateBroker = await createLinuxControllerStateBroker({ socketPath: stateSocket, store, validatePeer,
      ...(options.updates ? { updates: options.updates } : {}),
      heartbeatSequence: signal => {
        sequenceReserve ??= createHeartbeatSequenceReserve(join(stateDir, "identity.json"), origin);
        return sequenceReserve.then(reserve => reserve(signal));
      } });
    child = spawn("/proc/self/fd/4", [join(base, "root"), packageDir, installDir, stateDir, join(base, "scratch"), socketPath, stateSocket,
      ...(gpu ? ["--cuda-device"] : []), "--", "/app/node/bin/node", "/app/app/worker/dist/controller-entry.js", origin, options.updates ? "updates" : "no-updates"],
    { env: {}, cwd: "/", stdio: ["ignore", "pipe", "pipe", "pipe", helper.fd] });
    closed = waitClose(child);
    // Runtime output remains stream-oriented. Diagnostics are not persisted,
    // and the drain prevents a full pipe from delaying native termination.
    child.stdout?.on("data", () => undefined); child.stderr?.on("data", () => undefined);
    abort = () => {
      if (running && child && closed) void stopChild(child, closed).catch(() => { child?.kill("SIGKILL"); });
      else child?.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const channel = child.stdio[3] as Duplex;
    const ready = await new Promise<{ dev: string; ino: string }>((resolveReady, reject) => {
      let bytes = Buffer.alloc(0), done = false;
      const finish = (error?: Error, value?: { dev: string; ino: string }) => {
        if (done) return; done = true; clearTimeout(timer);
        channel.removeListener("data", data);
        if (error) reject(error); else resolveReady(value!);
      };
      const failed = () => finish(Error("CONTROLLER_START_FAILED"));
      const data = (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 256) { failed(); return; }
        if (!bytes.includes(10)) return;
        try {
          if (bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10)) throw Error("frame");
          const event = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
          if (Object.keys(event).sort().join(",") !== "netDev,netIno,profile" || event.profile !== PROFILE ||
              typeof event.netDev !== "string" || typeof event.netIno !== "string" || !SAFE_DECIMAL.test(event.netDev) || !SAFE_DECIMAL.test(event.netIno)) throw Error("frame");
          finish(undefined, { dev: event.netDev, ino: event.netIno });
        } catch { failed(); }
      };
      // FD3 is deliberately closed by the native child after its ACK. Keep the
      // guarded listener attached so a later pipe reset cannot escape the host.
      const timer = setTimeout(failed, 5000); channel.on("data", data); channel.on("error", failed);
      void closed!.then(failed);
    });
    const actual = await namespaceOf(child.pid!), host = await namespaceOf(process.pid);
    if (actual.dev !== ready.dev || actual.ino !== ready.ino || (actual.dev === host.dev && actual.ino === host.ino)) throw Error("CONTROLLER_NAMESPACE_INVALID");
    expected = Object.freeze(ready);
    if (options.signal?.aborted) throw Error("CONTROLLER_CANCELLED");
    await setWorkerControl(stateDir, "run");
    running = true;
    channel.write("OK"); channel.end();
    const liveChild = child, processClosed = closed;
    const completed = processClosed.then(async result => {
      return Object.freeze({ ...result, cleaned: await cleanup(true) });
    });
    return Object.freeze({ namespace: expected, closed: completed, stop: () => stopChild(liveChild, completed) });
  } catch {
    let reaped = !child;
    try { if (child && closed) { await stopChild(child, closed); reaped = true; } }
    finally { await cleanup(reaped); }
    throw Error(options.signal?.aborted ? "CONTROLLER_CANCELLED" : "CONTROLLER_START_FAILED");
  } finally { await helper.close(); }
}
