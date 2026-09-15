import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beginPairing, writeIdentity, finishPairing, sendHeartbeat } from "./identity.js";
import { textInstallationPlan, installTextAdapter, installMediaModel, mediaInstallationPlan, installedComponents, type Backend } from "@excess/adapters";
import { priceUnit, servedModel, servedModels } from "./served.js";
import { runWorker } from "./runtime.js";
import { readWorkerStatus, setWorkerControl } from "./control.js";
import { readWorkerPolicy, writeWorkerPolicy } from "./policy.js";
import { observeLocalResources } from "./telemetry.js";
import { runLocalProbe } from "./probe.js";
import { readWorkerOffer, writeWorkerOffer, offerFromSymbol } from "./offer.js";
import { workerGuide } from "./guide.js";
const execute = promisify(execFile);

async function nvidiaGpus(): Promise<{ name: string; memoryMb: number }[]> {
  try {
    const { stdout } = await execute("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, maxBuffer: 16384, windowsHide: true });
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [name, memory] = line.split(",").map(part => part.trim());
      return { name: name ?? "unknown", memoryMb: Number(memory) || 0 };
    });
  } catch { return []; }
}
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
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
try {
  const command = process.argv[2], args = process.argv.slice(3);
  const flags = new Set(args.filter(arg => arg.startsWith("--"))), positional = args.filter(arg => !arg.startsWith("--"));
  const stateDir = resolve(process.env.EXCESS_WORKER_HOME ?? ".local/worker"), installDir = resolve(process.env.EXCESS_MODEL_DIR ?? ".local/ai");
  const path = resolve(stateDir, "identity.json");
  // --gpu means CUDA on Windows and Vulkan on Linux.
  const gpuBackend: Backend = process.platform === "win32" ? "cuda" : "vulkan";
  const chosenBackend = (fallback: Backend): Backend => flags.has("--gpu") ? gpuBackend : flags.has("--cpu") ? "cpu" : fallback;
  if (command === "doctor") print(await diagnostics());
  else if (command === "pair") {
    let exists = false;
    try { await access(path); exists = true; } catch { /* New identity. */ }
    if (exists) throw Error("Device identity already exists; use complete-pairing or heartbeat");
    const origin = process.argv[3] ?? "http://127.0.0.1:4310";
    const result = await beginPairing(origin, process.argv[4] ?? os.hostname());
    await mkdir(stateDir, { recursive: true });
    await writeIdentity(path, result.identity);
    print({ product: "EXCESS", code: result.code, fingerprint: result.fingerprint, expiresAt: result.expiresAt, identityFile: path,
      next: "Approve this code and fingerprint with your wallet, then run complete-pairing." });
  } else if (command === "complete-pairing") process.stdout.write(JSON.stringify(await finishPairing(path)) + "\n");
  else if (command === "heartbeat") process.stdout.write(JSON.stringify(await sendHeartbeat(path)) + "\n");
  else if (command === "models") {
    // What this computer can run: system memory for CPU inference, NVIDIA GPU memory for full offload.
    const [policy, installed, gpus] = await Promise.all([readWorkerPolicy(stateDir), installedComponents(installDir), nvidiaGpus()]);
    const memoryMb = Math.floor(os.totalmem() / 1048576), bestGpuMb = Math.max(0, ...gpus.map(gpu => gpu.memoryMb));
    const runtimesInstalled = { "llama.cpp": installed.runtimes, "stable-diffusion.cpp": installed.sdRuntimes };
    print({ product: "EXCESS", hardware: { memoryMb, gpus }, active: { model: policy.model, backend: policy.backend }, runtimesInstalled,
      models: servedModels().map(entry => ({ id: entry.id, kind: entry.kind, name: entry.displayName, parameters: entry.parameters, quantization: entry.quantization,
        meteringUnit: entry.meteringUnit, pricedPer: priceUnit(entry.kind).label, runtime: entry.engine,
        downloadBytes: entry.downloadBytes, installed: installed.models.includes(entry.id), gpuOnly: entry.gpuOnly,
        cpu: { needsMemoryMb: entry.minMemoryMb, fits: !entry.gpuOnly && memoryMb >= entry.minMemoryMb + 2048 },
        gpu: { needsGpuMemoryMb: entry.minVramMb, fits: bestGpuMb >= entry.minVramMb } })),
      next: "excess-worker use <model id> [--gpu], then excess-worker install-model <model id> [--gpu] --accept-download --accept-licenses",
      note: "Kinds: text (streamed), embedding, transcription and image (buffered). GPU mode needs an NVIDIA GPU with a current driver on Windows or a Vulkan driver on Linux; gpuOnly models never run on the CPU. Fit estimates are guidance; the worker's local check decides." });
  } else if (command === "use") {
    if (positional.length !== 1) throw Error("Usage: worker use <model id> [--gpu | --cpu]");
    const current = await readWorkerPolicy(stateDir), entry = servedModel(positional[0]!);
    if (entry.gpuOnly && flags.has("--cpu")) throw Error("This model runs on a GPU only; use --gpu");
    const backend = entry.gpuOnly ? gpuBackend : chosenBackend("cpu");
    const policy = await writeWorkerPolicy(stateDir, { ...current, model: entry.id, backend,
      maxMemoryMb: backend === "cpu" ? Math.max(current.maxMemoryMb, entry.minMemoryMb) : current.maxMemoryMb });
    print({ product: "EXCESS", policy, kind: entry.kind, next: `excess-worker install-model ${entry.id}${backend !== "cpu" ? " --gpu" : ""} --accept-download --accept-licenses (if not installed), then excess-worker offer <SYMBOL> <price per ${priceUnit(entry.kind).label}>` });
  } else if (command === "model-plan") {
    const policy = await readWorkerPolicy(stateDir), id = positional[0] ?? policy.model;
    print(servedModel(id).kind === "text" ? textInstallationPlan(installDir, id, chosenBackend(policy.backend)) : mediaInstallationPlan(installDir, id, chosenBackend(policy.backend)));
  } else if (command === "install-model") {
    if (!flags.has("--accept-download") || !flags.has("--accept-licenses") || positional.length > 1)
      throw Error("Read worker model-plan, then use install-model [model id] [--gpu] --accept-download --accept-licenses to opt in");
    const policy = await readWorkerPolicy(stateDir), id = positional[0] ?? policy.model;
    // The packaged launcher points EXCESS_REDIST_DIR at the bundled Visual C++ runtime files.
    const install = { consent: true as const, modelId: id, backend: chosenBackend(policy.backend),
      ...(process.env.EXCESS_REDIST_DIR ? { redistDirectory: resolve(process.env.EXCESS_REDIST_DIR) } : {}),
      onProgress: (value: unknown) => process.stdout.write(JSON.stringify({ product: "EXCESS", download: value }) + "\n") };
    print(servedModel(id).kind === "text" ? await installTextAdapter(installDir, install) : await installMediaModel(installDir, install));
  } else if (command === "policy") {
    const file = process.argv[3];
    if (process.argv.length > 4) throw Error("Usage: worker policy [policy.json]");
    let policy;
    if (file) {
      const raw = await readFile(resolve(file), "utf8");
      if (Buffer.byteLength(raw) > 4096) throw Error("Policy file too large");
      policy = await writeWorkerPolicy(stateDir, JSON.parse(raw));
    } else policy = await readWorkerPolicy(stateDir);
    print({ product: "EXCESS", policy });
  } else if (command === "guide") {
    print(await workerGuide(path, stateDir, installDir));
  } else if (command === "offer") {
    const policy = await readWorkerPolicy(stateDir), unit = priceUnit(servedModel(policy.model).kind);
    if (positional.length === 0) print({ product: "EXCESS", model: policy.model, pricedPer: unit.label, offer: await readWorkerOffer(stateDir, policy.model) });
    else if (positional.length === 2) {
      const [target, price] = [positional[0]!, positional[1]!];
      // An asset ID takes exact base units per metering unit; a symbol takes a human price per million tokens, audio hour or image.
      const input = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target) ? { assetId: target, netUnits: price }
        : await offerFromSymbol((JSON.parse(await readFile(path, "utf8")) as { origin: string }).origin, target, price, unit);
      print({ product: "EXCESS", model: policy.model, pricedPer: unit.label, offer: await writeWorkerOffer(stateDir, input, policy.model),
        next: `While running, the worker publishes this net price per ${unit.unit} for the selected model after its local probe passes.` });
    } else throw Error("Usage: worker offer [SYMBOL pricePerMillionTokens|pricePerAudioHour|pricePerImage | assetId netUnitsPerMeteringUnit]");
  } else if (command === "status") print({ product: "EXCESS", ...await readWorkerStatus(stateDir) });
  else if (command === "drain" || command === "stop-now") {
    await setWorkerControl(stateDir, command === "drain" ? "drain" : "stop");
    process.stdout.write(JSON.stringify({ product: "EXCESS", requested: command, status: await readWorkerStatus(stateDir) }) + "\n");
  } else if (command === "run" || command === "resume") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    await setWorkerControl(stateDir, "run");
    await runWorker({ identityPath: path, stateDir, installDir, telemetry: observeLocalResources, signal: controller.signal });
    print({ product: "EXCESS", ...await readWorkerStatus(stateDir) });
  } else if (command === "probe") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    print(await runLocalProbe({ stateDir, installDir, signal: controller.signal }));
  } else throw Error("Usage: worker guide | doctor | models | use <model id> [--gpu] | pair [origin] [label] | complete-pairing | heartbeat | model-plan [model id] [--gpu] | install-model [model id] [--gpu] --accept-download --accept-licenses | policy [file] | offer [SYMBOL price | assetId netUnitsPerMeteringUnit] | status | run | drain | stop-now | resume | probe");
} catch (error) {
  const safe = error instanceof Error && !/private|secret|password/i.test(error.message) ? error.message : "Worker identity operation failed";
  // Only a system error code (such as EPERM or ENOSPC) is added; paths and messages stay out of the output.
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  process.stderr.write(safe + (typeof cause === "string" && /^E[A-Z]{2,16}$/.test(cause) ? " (" + cause + ")" : "") + "\n"); process.exitCode = 1;
}
