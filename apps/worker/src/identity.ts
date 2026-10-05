import { generateKeyPairSync, createPrivateKey, createHash, randomUUID, sign } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MAX_WORKER_MESSAGE_BYTES, parseWorkerMessage } from "@excess/protocol";
import { atomicPrivateJson } from "./control.js";
export interface WorkerIdentity {
  version: 1; origin: string; chainId: number; publicKey: string; privateKey: string;
  protection: "dpapi-current-user" | "file-mode-0600"; pairingId: string; challenge: string;
  deviceId?: string; sequence: number;
}
function originUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw Error("Use a canonical HTTPS origin or loopback HTTP origin");
  return url.origin;
}
async function dpapi(value: string, operation: "Protect" | "Unprotect"): Promise<string> {
  const script = "Add-Type -AssemblyName System.Security; $taskBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
    "[Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::" + operation + "($taskBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("Device key protection timed out")); }, 10000);
    child.on("error", () => { clearTimeout(timer); reject(Error("Device key protection unavailable")); });
    child.stderr.resume(); // Never log plaintext key material or provider output.
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 16384) child.kill(); });
    child.stdin.on("error", () => {});
    child.once("exit", code => {
      clearTimeout(timer);
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) reject(Error("Device key protection failed"));
      else resolve(output);
    });
    child.stdin.end(value);
  });
}
export class WorkerConnectionError extends Error {
  constructor(readonly status: number | null, readonly code = "COORDINATOR_UNAVAILABLE") { super("Coordinator request failed: " + (status ?? code)); this.name = "WorkerConnectionError"; }
}
export type CoordinatorFetcher = typeof fetch;
async function request(origin: string, path: string, payload?: unknown, signal?: AbortSignal, fetcher: CoordinatorFetcher = fetch) {
  let response: Response;
  try {
    const target = new URL(path, origin);
    if (target.origin !== origin || target.pathname !== path || target.search || target.hash || target.username || target.password) {
      throw new Error("Coordinator request escaped its paired origin");
    }
    response = await fetcher(target, {
      method: payload === undefined ? "GET" : "POST", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
    });
  } catch { throw new WorkerConnectionError(null); }
  if (!response.body) throw new WorkerConnectionError(response.status);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.length; if (bytes > 1048576 /* job.input carries up to 64 KiB of JSON-escaped embedding inputs; job.artifact.read a base64 256 KiB part */) throw Error("Coordinator response too large"); chunks.push(result.value); }
  } catch (error) {
    // Best-effort disposal must not replace the response/size error that caused it.
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new WorkerConnectionError(response.status, "INVALID_COORDINATOR_RESPONSE"); }
  if (!response.ok) {
    const code = value?.error?.code;
    throw new WorkerConnectionError(response.status, typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "COORDINATOR_REJECTED");
  }
  return value;
}
export async function beginPairing(origin: string, label: string, fetcher: CoordinatorFetcher = fetch): Promise<{ identity: WorkerIdentity; code: string; fingerprint: string; expiresAt: string }> {
  origin = originUrl(origin);
  const config = await request(origin, "/v1/public-config", undefined, undefined, fetcher);
  if (config.product !== "EXCESS" || !Number.isSafeInteger(config.chainId) || config.chainId < 1) throw Error("Invalid coordinator identity");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateDer = keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const fingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  const pairing = await request(origin, "/v1/devices/pairing/start", { publicKey, label }, undefined, fetcher);
  const challenge = JSON.parse(pairing.challenge);
  if (challenge.protocol !== "EXCESS_DEVICE_PAIR_V1" || challenge.origin !== origin || challenge.chainId !== config.chainId ||
      challenge.pairingId !== pairing.pairingId || challenge.fingerprint !== fingerprint || pairing.fingerprint !== fingerprint ||
      Date.parse(challenge.expiresAt) <= Date.now() || Date.parse(challenge.expiresAt) > Date.now() + 310000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)) throw Error("Invalid device challenge");
  const protection = process.platform === "win32" ? "dpapi-current-user" : "file-mode-0600";
  const privateKey = protection === "dpapi-current-user" ? await dpapi(privateDer, "Protect") : privateDer;
  return { identity: { version: 1, origin, chainId: config.chainId, publicKey, privateKey, protection,
    pairingId: pairing.pairingId, challenge: pairing.challenge, sequence: 0 }, code: pairing.code, fingerprint, expiresAt: pairing.expiresAt };
}
export async function writeIdentity(path: string, identity: WorkerIdentity) {
  // Never replace an existing identity on initial pairing.
  await writeFile(path, JSON.stringify(identity, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function key(identity: WorkerIdentity) {
  const plaintext = identity.protection === "dpapi-current-user" ? await dpapi(identity.privateKey, "Unprotect") : identity.privateKey;
  return createPrivateKey({ key: Buffer.from(plaintext, "base64"), type: "pkcs8", format: "der" });
}
const identityOperations = new Map<string, Promise<unknown>>();
async function withIdentity<T>(path: string, action: (identity: WorkerIdentity, save: () => Promise<void>) => Promise<T>): Promise<T> {
  path = resolve(path);
  const operation = (identityOperations.get(path) ?? Promise.resolve()).catch(() => {}).then(() => withIdentityLock(path, action));
  identityOperations.set(path, operation);
  try { return await operation; }
  finally { if (identityOperations.get(path) === operation) identityOperations.delete(path); }
}
async function withIdentityLock<T>(path: string, action: (identity: WorkerIdentity, save: () => Promise<void>) => Promise<T>): Promise<T> {
  // Lock file fences simultaneous CLI operations. A crash requires manual review/removal of this lock.
  const lock = await open(path + ".lock", "wx", 0o600);
  try {
    const identity = await readIdentity(path);
    return await action(identity, async () => {
      await atomicPrivateJson(path, identity);
    });
  } finally { await lock.close(); await unlink(path + ".lock"); }
}
async function readIdentity(path: string): Promise<WorkerIdentity> {
  const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16384 ||
        (process.platform === "linux" && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))) throw Error("Invalid device identity");
    const identity = JSON.parse(await file.readFile("utf8")) as WorkerIdentity;
    if (!identity || identity.version !== 1 || originUrl(identity.origin) !== identity.origin ||
        !Number.isSafeInteger(identity.sequence) || identity.sequence < 0 ||
        !["dpapi-current-user", "file-mode-0600"].includes(identity.protection)) throw Error("Invalid device identity");
    return identity;
  } finally { await file.close(); }
}
/** Host-only allocator. The confined worker can reserve a monotonic counter,
 * but cannot choose identity bytes, reset it or rewrite credentials. */
export async function createHeartbeatSequenceReserve(path: string, expectedOrigin: string): Promise<(signal?: AbortSignal) => Promise<number>> {
  const binding = await withIdentity(path, async identity => {
    if (!identity.deviceId || identity.origin !== originUrl(expectedOrigin)) throw Error("Paired identity required");
    return { deviceId: identity.deviceId, publicKey: identity.publicKey, origin: identity.origin, chainId: identity.chainId };
  });
  return signal => withIdentity(path, async (current, save) => {
    if (signal?.aborted) throw Error("HEARTBEAT_SEQUENCE_CANCELLED");
    if (current.deviceId !== binding.deviceId || current.publicKey !== binding.publicKey || current.origin !== binding.origin ||
        current.chainId !== binding.chainId || current.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Device identity changed or exhausted");
    current.sequence++; await save();
    return current.sequence;
  });
}
export async function finishPairing(path: string, fetcher: CoordinatorFetcher = fetch) {
  return withIdentity(path, async (identity, save) => {
    if (identity.deviceId) return { deviceId: identity.deviceId };
    const signature = sign(null, Buffer.from(identity.challenge), await key(identity)).toString("base64");
    const result = await request(identity.origin, "/v1/devices/pairing/complete", { pairingId: identity.pairingId, signature }, undefined, fetcher);
    if (typeof result.deviceId !== "string" || !/^[0-9a-f-]{36}$/.test(result.deviceId)) throw Error("Invalid device registration");
    identity.deviceId = result.deviceId; await save();
    return { deviceId: identity.deviceId };
  });
}
export type HeartbeatCapacity = { availableSlots: number; totalSlots?: number; capabilityDigests: string[] };
export async function sendHeartbeat(path: string, capacity: HeartbeatCapacity = { availableSlots: 0, capabilityDigests: [] }, fetcher: CoordinatorFetcher = fetch) {
  return withIdentity(path, async (identity, save) => {
    if (!identity.deviceId || identity.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Paired identity required");
    identity.sequence++; await save(); // Reserve sequence before sending, including lost-response cases.
    const message = JSON.stringify({ version: 1, messageId: randomUUID(), correlationId: randomUUID(), sentAt: new Date().toISOString(),
      type: "worker.heartbeat", data: { ...capacity, deviceId: identity.deviceId, sequence: identity.sequence } });
    parseWorkerMessage(message);
    return request(identity.origin, "/v1/worker/heartbeat", { message, signature: sign(null, Buffer.from(message), await key(identity)).toString("base64") }, undefined, fetcher);
  });
}
export interface WorkerConnection {
  deviceId: string;
  origin?: string;
  heartbeat(capacity: HeartbeatCapacity, signal?: AbortSignal): Promise<unknown>;
  command(type: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  offer?(data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export async function createWorkerConnection(path: string, fetcher: CoordinatorFetcher = fetch,
  readonlyState?: { reserveHeartbeatSequence(signal?: AbortSignal): Promise<number> }): Promise<WorkerConnection> {
  // The foreground runtime decrypts once; no private key leaves this process.
  const initialize = async (identity: WorkerIdentity) => {
    if (!identity.deviceId) throw Error("Paired identity required");
    return { identity: { ...identity }, signingKey: await key(identity) };
  };
  const initial = readonlyState ? await initialize(await readIdentity(path)) : await withIdentity(path, initialize);
  const { identity, signingKey } = initial;
  const makeMessage = (type: string, data: Record<string, unknown>) => {
    const message = JSON.stringify({ version: 1, messageId: randomUUID(), correlationId: randomUUID(), sentAt: new Date().toISOString(),
      type, data: { ...data, deviceId: identity.deviceId } });
    if (Buffer.byteLength(message) > MAX_WORKER_MESSAGE_BYTES) throw Error("Worker message exceeds transport limit");
    parseWorkerMessage(message);
    return { message, signature: sign(null, Buffer.from(message), signingKey).toString("base64") };
  };
  let heartbeatTail: Promise<unknown> = Promise.resolve();
  const readonlyHeartbeat = (capacity: HeartbeatCapacity, signal?: AbortSignal) => {
    const operation = heartbeatTail.catch(() => {}).then(async () => {
      if (signal?.aborted) throw Error("HEARTBEAT_SEQUENCE_CANCELLED");
      const sequence = await readonlyState!.reserveHeartbeatSequence(signal);
      if (!Number.isSafeInteger(sequence) || sequence <= identity.sequence) throw Error("Heartbeat sequence did not advance");
      identity.sequence = sequence;
      return request(identity.origin, "/v1/worker/heartbeat", makeMessage("worker.heartbeat", { ...capacity, sequence }), signal, fetcher);
    });
    heartbeatTail = operation; return operation;
  };
  return {
    deviceId: identity.deviceId!,
    origin: identity.origin,
    heartbeat: readonlyState ? readonlyHeartbeat : (capacity, signal) => withIdentity(path, async (current, save) => {
      if (current.deviceId !== identity.deviceId || current.publicKey !== identity.publicKey || current.origin !== identity.origin || current.chainId !== identity.chainId || current.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Device identity changed or exhausted");
      current.sequence++; await save();
      return request(identity.origin, "/v1/worker/heartbeat", makeMessage("worker.heartbeat", { ...capacity, sequence: current.sequence }), signal, fetcher);
    }),
    command: (type, data, signal) => request(identity.origin, "/v1/worker/command", makeMessage(type, data), signal, fetcher),
    offer: (data, signal) => request(identity.origin, "/v1/worker/offer", makeMessage("worker.offer", data), signal, fetcher),
  };
}
