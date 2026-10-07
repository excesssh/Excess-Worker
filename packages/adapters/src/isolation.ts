import { readFile, mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AdapterError } from "./manifest.js";
import { isolateWindowsRuntime } from "./windows-isolation.js";
import type { RuntimeSupervision } from "./native-process.js";

export interface RuntimeIsolation {
  executable: string; args: string[]; scratch: string; profile: string; supervision?:RuntimeSupervision; cleanup(): Promise<void>;
}
export interface RuntimeFilePin { path: string; sha256: string }
/** Only verified native launches use this boundary. Injected test servers are fixtures. */
export async function isolateRuntime(executable: string, args: readonly string[], options: {
  readPaths: readonly string[]; modelPaths?: readonly string[]; runtimeRoot?: string; runtimeFiles?: readonly RuntimeFilePin[]; modelFiles?: readonly RuntimeFilePin[];
  maxMemoryBytes: number; maxGpuMemoryBytes?: number; timeoutMs: number; port: number; backend: string;
}): Promise<RuntimeIsolation> {
  if(process.platform==="win32"){
    if(!options.runtimeRoot||!options.runtimeFiles?.length||!options.modelFiles?.length)throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
    return isolateWindowsRuntime(executable,args,{runtimeRoot:options.runtimeRoot,runtimeFiles:options.runtimeFiles,modelFiles:options.modelFiles,
      maxMemoryBytes:options.maxMemoryBytes,timeoutMs:options.timeoutMs,backend:options.backend,port:options.port,
      ...(options.maxGpuMemoryBytes!==undefined?{maxGpuMemoryBytes:options.maxGpuMemoryBytes}:{})});
  }
  if (process.platform !== "linux" || process.arch !== "x64") throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE");
  // This profile cannot safely account for GPU virtual-address reservations or grant driver access.
  if (options.backend !== "cpu") throw new AdapterError("GPU_ISOLATION_UNVERIFIED");
  const base = fileURLToPath(new URL("../native/", import.meta.url));
  const helper = join(base, "excess-sandbox");
  try {
    const pin = JSON.parse(await readFile(join(base, "integrity.json"), "utf8")) as { profile?: unknown; sha256?: unknown };
    const hash = createHash("sha256").update(await readFile(helper)).digest("hex");
    if (pin.profile !== "linux-landlock-v1" || typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256) || hash !== pin.sha256) throw Error();
  } catch { throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE"); }
  const parent = await realpath(tmpdir());
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, "excess-runtime-"));
  const cleanup = async () => {
    if (dirname(resolve(scratch)) !== parent || !scratch.startsWith(parent + sep + "excess-runtime-")) throw new AdapterError("RUNTIME_CLEANUP_FAILED");
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    const reads = [...new Set(await Promise.all(options.readPaths.map(path => realpath(path))))];
    const models = [...new Set(await Promise.all((options.modelPaths ?? []).map(path => realpath(path))))];
    if (models.length > 32) throw Error();
    return { executable: helper, args: [String(options.maxMemoryBytes), String(Math.ceil(options.timeoutMs / 1000) + 5), String(options.port), scratch,
      String(reads.length), ...reads, String(models.length), ...models, "--", await realpath(executable), ...args], scratch, profile: "linux-landlock-v1", cleanup };
  } catch { await cleanup(); throw new AdapterError("RUNTIME_ISOLATION_UNAVAILABLE"); }
}
