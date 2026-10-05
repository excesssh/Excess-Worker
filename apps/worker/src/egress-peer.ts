import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Socket } from "node:net";

export const LINUX_EGRESS_PEER_PROFILE = "linux-af-unix-peercred-v1" as const;
const NODE_RUNTIME = "v24.11.1";
const CHILD_TIMEOUT_MS = 900;
const MAX_RESULT_BYTES = 2048;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const HASH = /^[a-f0-9]{64}$/;

export type EgressPeerCode =
  | "ACCEPT"
  | "INVALID_ARGUMENTS"
  | "INVALID_SOCKET"
  | "BROKER_NAMESPACE_UNAVAILABLE"
  | "PEER_NAMESPACE_UNAVAILABLE"
  | "PEER_UID_MISMATCH"
  | "EXPECTED_NAMESPACE_IS_BROKER"
  | "PEER_NAMESPACE_MISMATCH";

export interface LinuxEgressPeerResult {
  readonly code: EgressPeerCode | "VALIDATOR_ERROR";
  readonly accepted: boolean;
  readonly peerPid: number | null;
  readonly peerUid: number | null;
  readonly peerNetDev: string | null;
  readonly peerNetIno: string | null;
}

export interface LinuxEgressPeerOptions {
  readonly helperPath: string;
  readonly integrityPath?: string;
  readonly expectedControllerNamespace: { readonly dev: string; readonly ino: string };
  readonly signal?: AbortSignal;
}

interface NativeRecord {
  code: EgressPeerCode;
  socket_valid: boolean;
  uid_match: boolean;
  peer_ns_readable: boolean;
  expected_ns_enabled: boolean;
  expected_ns_match: boolean;
  same_broker_namespace: boolean;
  peer_pid: number;
  peer_uid: number;
  peer_net_dev: string;
  peer_net_ino: string;
  broker_net_dev: string;
  broker_net_ino: string;
}

function denied(): LinuxEgressPeerResult {
  return Object.freeze({ code: "VALIDATOR_ERROR", accepted: false, peerPid: null, peerUid: null, peerNetDev: null, peerNetIno: null });
}

function validDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

function validIdentity(info: { uid: number; mode: number }): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && (info.uid === uid || info.uid === 0) && (info.mode & 0o022) === 0;
}

async function openPinnedFile(path: string, maximumBytes: number): Promise<{ handle: FileHandle; bytes: Buffer }> {
  const linkInfo = await lstat(path);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || !validIdentity(linkInfo) || linkInfo.size < 1 || linkInfo.size > maximumBytes) {
    throw new Error("file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !validIdentity(info) || info.size < 1 || info.size > maximumBytes || info.ino !== linkInfo.ino || info.dev !== linkInfo.dev) {
      throw new Error("file");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > maximumBytes) throw new Error("file");
    return { handle, bytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function loadVerifiedHelper(options: LinuxEgressPeerOptions): Promise<{ handle: FileHandle; hash: string }> {
  if (typeof options.helperPath !== "string" || options.helperPath.length === 0 || !validDecimal(options.expectedControllerNamespace?.dev) ||
      !validDecimal(options.expectedControllerNamespace?.ino)) throw new Error("arguments");
  const helperPath = resolve(options.helperPath);
  const integrityPath = resolve(options.integrityPath ?? resolve(dirname(helperPath), "integrity-egress-peer.json"));
  const pinFile = await openPinnedFile(integrityPath, 4096);
  let pin: unknown;
  try {
    pin = JSON.parse(pinFile.bytes.toString("utf8"));
  } finally {
    await pinFile.handle.close();
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) throw new Error("pin");
  const record = pin as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "profile,sha256" || record.profile !== LINUX_EGRESS_PEER_PROFILE ||
      typeof record.sha256 !== "string" || !HASH.test(record.sha256)) throw new Error("pin");
  const helper = await openPinnedFile(helperPath, 16 * 1024 * 1024);
  const hash = createHash("sha256").update(helper.bytes).digest("hex");
  if (hash !== record.sha256 || helper.handle.fd < 0) {
    await helper.handle.close().catch(() => undefined);
    throw new Error("hash");
  }
  return { handle: helper.handle, hash };
}

function socketFd(socket: Socket): number | null {
  if (socket.destroyed) return null;
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : null;
}

function parseNativeRecord(bytes: Buffer): NativeRecord | null {
  if (bytes.length === 0 || bytes.length > MAX_RESULT_BYTES || bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const keys = ["broker_net_dev", "broker_net_ino", "code", "expected_ns_enabled", "expected_ns_match", "peer_net_dev", "peer_net_ino", "peer_ns_readable", "peer_pid", "peer_uid", "same_broker_namespace", "socket_valid", "uid_match"];
  if (Object.keys(value).sort().join(",") !== keys.join(",") ||
      !["ACCEPT", "INVALID_ARGUMENTS", "INVALID_SOCKET", "BROKER_NAMESPACE_UNAVAILABLE", "PEER_NAMESPACE_UNAVAILABLE", "PEER_UID_MISMATCH", "EXPECTED_NAMESPACE_IS_BROKER", "PEER_NAMESPACE_MISMATCH"].includes(String(value.code)) ||
      typeof value.socket_valid !== "boolean" || typeof value.uid_match !== "boolean" || typeof value.peer_ns_readable !== "boolean" ||
      typeof value.expected_ns_enabled !== "boolean" || typeof value.expected_ns_match !== "boolean" || typeof value.same_broker_namespace !== "boolean" ||
      !Number.isSafeInteger(value.peer_pid) || (value.peer_pid as number) < 0 || !Number.isSafeInteger(value.peer_uid) || (value.peer_uid as number) < 0 ||
      !validDecimal(value.peer_net_dev) || !validDecimal(value.peer_net_ino) || !validDecimal(value.broker_net_dev) || !validDecimal(value.broker_net_ino)) return null;
  return value as unknown as NativeRecord;
}

async function runVerifier(socket: Socket, socketDescriptor: number, expected: { dev: string; ino: string }, helper: FileHandle, signal?: AbortSignal): Promise<Buffer | null> {
  if (socketFd(socket) !== socketDescriptor || signal?.aborted) return null;
  return new Promise(resolveResult => {
    let settled = false;
    let stopping = false;
    let failed = false;
    let output = Buffer.alloc(0);
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("close", onSocketClose);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const terminate = () => {
      if (stopping || settled) return;
      stopping = true;
      failed = true;
      if (!child) { finish(null); return; }
      if (child.pid === undefined) {
        child.once("spawn", () => { try { child?.kill("SIGKILL"); } catch { /* close event remains the reaping boundary */ } });
        child.once("error", () => finish(null));
        return;
      }
      try { child.kill("SIGKILL"); } catch { /* close event remains the reaping boundary */ }
    };
    const onSocketClose = () => terminate();
    const onAbort = () => terminate();
    const timer = setTimeout(terminate, CHILD_TIMEOUT_MS);
    timer.unref();
    socket.once("close", onSocketClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { terminate(); return; }
    try {
      child = spawn("/proc/self/fd/4", [
        `--expected-net-dev=${expected.dev}`,
        `--expected-net-ino=${expected.ino}`,
      ], { cwd: "/", env: {}, stdio: ["ignore", "pipe", "ignore", socketDescriptor, helper.fd] });
    } catch {
      finish(null);
      return;
    }
    if (!child.stdout) { terminate(); return; }
    child.stdout.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (output.length + part.length > MAX_RESULT_BYTES) { terminate(); return; }
      output = Buffer.concat([output, part]);
    });
    child.once("error", () => {
      failed = true;
      if (child?.pid === undefined) finish(null);
      else terminate();
    });
    child.once("close", (code, signal) => finish(!failed && code === 0 && signal === null ? output : null));
  });
}

/** Returns structured, bounded evidence; every local/setup failure maps to a fixed denial. */
export async function verifyLinuxEgressPeer(socket: Socket, options: LinuxEgressPeerOptions): Promise<LinuxEgressPeerResult> {
  if (process.platform !== "linux" || process.version !== NODE_RUNTIME || !process.getuid || options.signal?.aborted) return denied();
  const initialFd = socketFd(socket);
  if (initialFd === null) return denied();
  let helper: FileHandle | undefined;
  try {
    const expected = Object.freeze({
      dev: options.expectedControllerNamespace.dev,
      ino: options.expectedControllerNamespace.ino,
    });
    const stableOptions = Object.freeze({
      helperPath: options.helperPath,
      ...(options.integrityPath === undefined ? {} : { integrityPath: options.integrityPath }),
      expectedControllerNamespace: expected,
    });
    const verified = await loadVerifiedHelper(stableOptions);
    helper = verified.handle;
    if (options.signal?.aborted) return denied();
    const output = await runVerifier(socket, initialFd, expected, helper, options.signal);
    const record = output ? parseNativeRecord(output) : null;
    if (!record || socketFd(socket) !== initialFd || record.peer_uid !== process.getuid()) return denied();
    const accepted = record.code === "ACCEPT" && record.socket_valid && record.uid_match && record.peer_ns_readable &&
      record.expected_ns_enabled && record.expected_ns_match && !record.same_broker_namespace &&
      record.peer_net_dev === expected.dev && record.peer_net_ino === expected.ino &&
      (record.peer_net_dev !== record.broker_net_dev || record.peer_net_ino !== record.broker_net_ino);
    return Object.freeze({
      code: record.code,
      accepted,
      peerPid: record.peer_pid,
      peerUid: record.peer_uid,
      peerNetDev: record.peer_net_dev,
      peerNetIno: record.peer_net_ino,
    });
  } catch {
    return denied();
  } finally {
    await helper?.close().catch(() => undefined);
  }
}

/** Adapter for EgressBroker's required boolean peer-validation callback. */
export function createLinuxEgressPeerValidator(options: LinuxEgressPeerOptions): (socket: Socket, signal?: AbortSignal) => Promise<boolean> {
  return async (socket, signal) => (await verifyLinuxEgressPeer(socket, { ...options, ...(signal === undefined ? {} : { signal }) })).accepted;
}
