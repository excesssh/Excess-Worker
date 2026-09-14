import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { beginPairing, writeIdentity, finishPairing, sendHeartbeat } from "./identity.js";
const execute = promisify(execFile);

export async function diagnostics() {
  let nvidia: { status: string; devices: string[] } = { status: "unavailable", devices: [] };
  try {
    const { stdout } = await execute("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], { timeout: 5000, maxBuffer: 16384, windowsHide: true });
    nvidia = { status: "detected_not_execution_verified", devices: stdout.trim().split(/\r?\n/).filter(Boolean) };
  } catch { /* A missing NVIDIA utility does not imply an unsupported machine. */ }
  return {
    product: "EXCESS", kind: "local_diagnostics", protocolVersion: 1,
    platform: os.platform(), release: os.release(), architecture: os.arch(),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown", logicalCpus: os.cpus().length,
    memoryBytes: String(os.totalmem()), nvidia,
    executionBackends: [], verifiedCapabilities: [], registered: false,
    notes: ["Hardware discovery is not an execution probe.", "No models downloaded or jobs accepted.", "AMD, Intel and CPU execution remain untested."],
  };
}
try {
  const command = process.argv[2];
  const path = resolve(".local/worker/identity.json");
  if (command === "doctor") process.stdout.write(JSON.stringify(await diagnostics(), null, 2) + "\n");
  else if (command === "pair") {
    let exists = false;
    try { await access(path); exists = true; } catch { /* New identity. */ }
    if (exists) throw Error("Device identity already exists; use complete-pairing or heartbeat");
    const origin = process.argv[3] ?? "http://127.0.0.1:4310";
    const result = await beginPairing(origin, process.argv[4] ?? os.hostname());
    await mkdir(resolve(".local/worker"), { recursive: true });
    await writeIdentity(path, result.identity);
    process.stdout.write(JSON.stringify({ product: "EXCESS", code: result.code, fingerprint: result.fingerprint,
      expiresAt: result.expiresAt, identityFile: path,
      next: "Approve this code and fingerprint with your wallet, then run complete-pairing." }, null, 2) + "\n");
  } else if (command === "complete-pairing") process.stdout.write(JSON.stringify(await finishPairing(path)) + "\n");
  else if (command === "heartbeat") process.stdout.write(JSON.stringify(await sendHeartbeat(path)) + "\n");
  else throw Error("Usage: worker doctor | pair [origin] [label] | complete-pairing | heartbeat");
} catch (error) {
  const safe = error instanceof Error && !/private|secret|password/i.test(error.message) ? error.message : "Worker identity operation failed";
  process.stderr.write(safe + "\n"); process.exitCode = 1;
}
