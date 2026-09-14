import { generateKeyPairSync, createPrivateKey, createHash, randomUUID, sign } from "node:crypto";
import { readFile, writeFile, open, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
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
async function request(origin: string, path: string, payload?: unknown) {
  const response = await fetch(new URL(path, origin), {
    method: payload === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  });
  if (!response.ok || !response.body) throw Error("Coordinator request failed: " + response.status);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const result = await reader.read(); if (result.done) break; bytes += result.value.length; if (bytes > 32768) throw Error("Coordinator response too large"); chunks.push(result.value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function beginPairing(origin: string, label: string): Promise<{ identity: WorkerIdentity; code: string; fingerprint: string; expiresAt: string }> {
  origin = originUrl(origin);
  const config = await request(origin, "/v1/public-config");
  if (config.product !== "EXCESS" || !Number.isSafeInteger(config.chainId) || config.chainId < 1) throw Error("Invalid coordinator identity");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateDer = keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const fingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
  const pairing = await request(origin, "/v1/devices/pairing/start", { publicKey, label });
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
async function withIdentity<T>(path: string, action: (identity: WorkerIdentity, save: () => Promise<void>) => Promise<T>): Promise<T> {
  // Lock file fences simultaneous CLI operations. A crash requires manual review/removal of this lock.
  const lock = await open(path + ".lock", "wx", 0o600);
  try {
    const identity = JSON.parse(await readFile(path, "utf8")) as WorkerIdentity;
    if (identity.version !== 1 || originUrl(identity.origin) !== identity.origin ||
        !Number.isSafeInteger(identity.sequence) || identity.sequence < 0 ||
        !["dpapi-current-user", "file-mode-0600"].includes(identity.protection)) throw Error("Invalid device identity");
    return await action(identity, async () => {
      const temporary = path + ".pending-" + randomUUID();
      await writeFile(temporary, JSON.stringify(identity, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    });
  } finally { await lock.close(); await unlink(path + ".lock"); }
}
export async function finishPairing(path: string) {
  return withIdentity(path, async (identity, save) => {
    if (identity.deviceId) return { deviceId: identity.deviceId };
    const signature = sign(null, Buffer.from(identity.challenge), await key(identity)).toString("base64");
    const result = await request(identity.origin, "/v1/devices/pairing/complete", { pairingId: identity.pairingId, signature });
    if (typeof result.deviceId !== "string" || !/^[0-9a-f-]{36}$/.test(result.deviceId)) throw Error("Invalid device registration");
    identity.deviceId = result.deviceId; await save();
    return { deviceId: identity.deviceId };
  });
}
export async function sendHeartbeat(path: string) {
  return withIdentity(path, async (identity, save) => {
    if (!identity.deviceId || identity.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Paired identity required");
    identity.sequence++; await save(); // Reserve sequence before sending, including lost-response cases.
    const message = JSON.stringify({ version: 1, messageId: randomUUID(), correlationId: randomUUID(), sentAt: new Date().toISOString(),
      type: "worker.heartbeat", data: { deviceId: identity.deviceId, sequence: identity.sequence, availableSlots: 0, capabilityDigests: [] } });
    return request(identity.origin, "/v1/worker/heartbeat", { message, signature: sign(null, Buffer.from(message), await key(identity)).toString("base64") });
  });
}
