import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beginPairing, writeIdentity, finishPairing, sendHeartbeat } from "./identity.js";
import { textInstallationPlan, installTextAdapter } from "@excess/adapters";
import { runWorker } from "./runtime.js";
import { readWorkerStatus, setWorkerControl } from "./control.js";
import { readWorkerPolicy, writeWorkerPolicy } from "./policy.js";
import { observeLocalResources } from "./telemetry.js";
import { runLocalProbe } from "./probe.js";
import { readWorkerOffer, writeWorkerOffer, offerFromSymbol } from "./offer.js";
import { workerGuide } from "./guide.js";
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
    executionBackends: [], verifiedCapabilities: [], registrationChecked: false,
    notes: ["Hardware discovery is not an execution probe.", "This command does not download models or accept jobs.", "Use probe for installed-model execution checks and status for local worker state; this inventory does not establish live supply."],
  };
}
try {
  const command = process.argv[2];
  const stateDir=resolve(process.env.EXCESS_WORKER_HOME??".local/worker"),installDir=resolve(process.env.EXCESS_MODEL_DIR??".local/models/qwen3-0.6b-cpu-v1");
  const path=resolve(stateDir,"identity.json");
  if (command === "doctor") process.stdout.write(JSON.stringify(await diagnostics(), null, 2) + "\n");
  else if (command === "pair") {
    let exists = false;
    try { await access(path); exists = true; } catch { /* New identity. */ }
    if (exists) throw Error("Device identity already exists; use complete-pairing or heartbeat");
    const origin = process.argv[3] ?? "http://127.0.0.1:4310";
    const result = await beginPairing(origin, process.argv[4] ?? os.hostname());
    await mkdir(stateDir, { recursive: true });
    await writeIdentity(path, result.identity);
    process.stdout.write(JSON.stringify({ product: "EXCESS", code: result.code, fingerprint: result.fingerprint,
      expiresAt: result.expiresAt, identityFile: path,
      next: "Approve this code and fingerprint with your wallet, then run complete-pairing." }, null, 2) + "\n");
  } else if (command === "complete-pairing") process.stdout.write(JSON.stringify(await finishPairing(path)) + "\n");
  else if (command === "heartbeat") process.stdout.write(JSON.stringify(await sendHeartbeat(path)) + "\n");
  else if(command==="model-plan") process.stdout.write(JSON.stringify(textInstallationPlan(installDir),null,2)+"\n");
  else if(command==="install-model") {
    if(process.argv.length!==5 || !process.argv.slice(3).includes("--accept-download") || !process.argv.slice(3).includes("--accept-licenses"))
      throw Error("Read worker model-plan, then use install-model --accept-download --accept-licenses to opt in");
    process.stdout.write(JSON.stringify(await installTextAdapter(installDir,{consent:true,onProgress:value=>process.stdout.write(JSON.stringify({product:"EXCESS",download:value})+"\n")}),null,2)+"\n");
  } else if(command==="policy") {
    const file=process.argv[3];
    if(process.argv.length>4) throw Error("Usage: worker policy [policy.json]");
    let policy;
    if(file) {
      const raw=await readFile(resolve(file),"utf8");
      if(Buffer.byteLength(raw)>4096) throw Error("Policy file too large");
      policy=await writeWorkerPolicy(stateDir,JSON.parse(raw));
    } else policy=await readWorkerPolicy(stateDir);
    process.stdout.write(JSON.stringify({product:"EXCESS",policy},null,2)+"\n");
  } else if(command==="guide") {
    process.stdout.write(JSON.stringify(await workerGuide(path,stateDir,installDir),null,2)+"\n");
  } else if(command==="offer") {
    if(process.argv.length===3) process.stdout.write(JSON.stringify({product:"EXCESS",offer:await readWorkerOffer(stateDir)},null,2)+"\n");
    else if(process.argv.length===5) {
      const [target,price]=[process.argv[3]!,process.argv[4]!];
      // An asset ID takes exact base units per token; a symbol takes a human price per million tokens.
      const input=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target)?{assetId:target,netUnits:price}
        :await offerFromSymbol((JSON.parse(await readFile(path,"utf8")) as {origin:string}).origin,target,price);
      process.stdout.write(JSON.stringify({product:"EXCESS",offer:await writeWorkerOffer(stateDir,input),
        next:"While running, the worker publishes this net price per output token after its local probe passes."},null,2)+"\n");
    }
    else throw Error("Usage: worker offer [SYMBOL pricePerMillionTokens | assetId netUnitsPerOutputToken]");
  } else if(command==="status") process.stdout.write(JSON.stringify({product:"EXCESS",...await readWorkerStatus(stateDir)},null,2)+"\n");
  else if(command==="drain" || command==="stop-now") {
    await setWorkerControl(stateDir,command==="drain"?"drain":"stop");
    process.stdout.write(JSON.stringify({product:"EXCESS",requested:command,status:await readWorkerStatus(stateDir)})+"\n");
  } else if(command==="run" || command==="resume") {
    const controller=new AbortController();
    process.once("SIGINT",()=>controller.abort()); process.once("SIGTERM",()=>controller.abort());
    await setWorkerControl(stateDir,"run");
    await runWorker({identityPath:path,stateDir,installDir,telemetry:observeLocalResources,signal:controller.signal});
    process.stdout.write(JSON.stringify({product:"EXCESS",...await readWorkerStatus(stateDir)},null,2)+"\n");
  } else if(command==="probe") {
    const controller=new AbortController();
    process.once("SIGINT",()=>controller.abort());process.once("SIGTERM",()=>controller.abort());
    process.stdout.write(JSON.stringify(await runLocalProbe({stateDir,installDir,signal:controller.signal}),null,2)+"\n");
  } else throw Error("Usage: worker guide | doctor | pair [origin] [label] | complete-pairing | heartbeat | model-plan | install-model --accept-download --accept-licenses | policy [file] | offer [SYMBOL pricePerMillionTokens | assetId netUnitsPerOutputToken] | status | run | drain | stop-now | resume | probe");
} catch (error) {
  const safe = error instanceof Error && !/private|secret|password/i.test(error.message) ? error.message : "Worker identity operation failed";
  process.stderr.write(safe + "\n"); process.exitCode = 1;
}
