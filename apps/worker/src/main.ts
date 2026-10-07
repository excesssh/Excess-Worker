import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants as fsConstants } from "node:fs";
import { mkdir, access, readFile, chmod, open } from "node:fs/promises";
import { resolve } from "node:path";
import { beginPairing, writeIdentity, finishPairing, sendHeartbeat } from "./identity.js";
import { textInstallationPlan, installTextAdapter, installMediaModel, mediaInstallationPlan, installedComponents, textInstallDiskCheck, mediaInstallDiskCheck, importModelFiles, type Backend, type DiskCheck } from "@excess/adapters";
import { priceUnit, servedModel, servedModels } from "./served.js";
import { runWorker, unpairDevice } from "./runtime.js";
import { readWorkerStatus, setWorkerControl, readWorkerControlRequest, startWorkerUpdate } from "./control.js";
import { describeSchedule, parseScheduleSpec, readWorkerPolicy, writeWorkerPolicy, THERMAL_STOP_MARGIN_C } from "./policy.js";
import { observeLocalResources, observeTemperatures } from "./telemetry.js";
import { runLocalProbe } from "./probe.js";
import { readWorkerOffers, writeWorkerOffer, removeWorkerOffer, setWorkerPriceBand, clearWorkerPriceBand, setWorkerAutoPrice, offerFromSymbol, assetFromSymbol } from "./offer.js";
import { workerGuide } from "./guide.js";
import { detectHardware, executionProfile, modelExecutionProfiles, modelPlanStatus, modelsByFit, modelsBySelectableFit } from "./hardware.js";
import { workerService } from "./service.js";
import { checkForUpdate, currentRelease, runInstaller, supervisedBySystemd, UPDATED_EXIT_CODE } from "./update.js";
import { startLinuxController } from "./controller.js";
import { runWindowsWorker } from "./windows-worker.js";
import { createControllerUpdatePlan } from "./controller-update.js";
import { createCoordinatorFetcher } from "./coordinator-fetch.js";
import { configuredControllerOrigin, saveControllerOrigin } from "./controller-config.js";
const execute = promisify(execFile);
const gigabytes = (bytes: number) => (bytes / 1073741824).toFixed(1) + " GB";
const memoryMb = (mb: number) => (Number.isInteger(mb / 1024) ? String(mb / 1024) : (mb / 1024).toFixed(1)) + " GB";
const diskMessage = (disk: DiskCheck) => `INSUFFICIENT_DISK_SPACE: this install needs ${gigabytes(disk.requiredBytes)} free on the model drive and ${gigabytes(disk.freeBytes ?? 0)} is free. Free space or set EXCESS_MODEL_DIR to a larger drive.`;
function selectionBudgetProblems(entry: ReturnType<typeof servedModel>, backend: Backend, policy: { maxMemoryMb: number; maxGpuMemoryMb: number; runSeconds:number }): string[] {
  const problems: string[] = [];
  const profile=executionProfile(entry,backend),hostFloor=profile.minimumHostMemoryMb??entry.minMemoryMb;
  if (backend === "cpu") {
    if(policy.maxMemoryMb<hostFloor)problems.push(`${entry.id} needs an explicit host memory cap of at least ${memoryMb(hostFloor)} for this execution profile; model selection does not raise it.`);
    if(profile.minimumRunSeconds&&policy.runSeconds<profile.minimumRunSeconds)problems.push(`${entry.id} needs an explicit runSeconds of at least ${profile.minimumRunSeconds} for this CPU profile; model selection does not raise it.`);
    return problems;
  }
  if (backend !== "cuda") return ["Isolated Vulkan execution is refused; choose CPU or the supported NVIDIA CUDA profile."];
  const windows = process.platform === "win32", linux = process.platform === "linux";
  if (!windows && !linux) return ["No isolated GPU profile is available on this operating system."];
  const minimumHostMb = hostFloor;
  const minimumGpuMb = profile.minimumGpuMemoryMb??entry.minVramMb;
  if (policy.maxMemoryMb < minimumHostMb) problems.push(`${entry.id} needs an explicit host memory cap of at least ${memoryMb(minimumHostMb)} for this CUDA profile; model selection does not raise it.`);
  if (policy.maxGpuMemoryMb < minimumGpuMb) problems.push(`${entry.id} needs an explicit GPU memory budget of at least ${memoryMb(minimumGpuMb)}; model selection does not raise it.`);
  if (windows && policy.maxGpuMemoryMb > 32768) problems.push("Windows CUDA GPU memory budget cannot exceed 32 GB.");
  if (linux && policy.maxGpuMemoryMb > 131072) problems.push("Linux CUDA GPU memory budget cannot exceed 128 GB.");
  if (linux && policy.maxMemoryMb > 129024) problems.push("Linux CUDA host memory cap cannot exceed 126 GB; the controller needs 2 GB within the 128 GB total budget.");
  return problems;
}
export async function diagnostics() {
  let nvidia: { status: string; devices: string[] } = { status: "unavailable", devices: [] };
  try {
    const { stdout } = await execute("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], { timeout: 5000, maxBuffer: 16384, windowsHide: true });
    nvidia = { status: "detected_not_execution_verified", devices: stdout.trim().split(/\r?\n/).filter(Boolean) };
  } catch { /* A missing NVIDIA utility does not imply an unsupported machine. */ }
  // An installed llama.cpp runtime whose shared libraries do not resolve dies at start with a bare RUNTIME_EXITED,
  // so name the missing libraries here instead. A clean Ubuntu has no libgomp.so.1, which llama.cpp always needs.
  const runtimeLibraries: { backend: string; missing: string[] }[] = [];
  if (os.platform() === "linux") {
    const root = process.env.EXCESS_MODEL_DIR ?? resolve(os.homedir(), ".local/share/excess/ai");
    for (const backend of ["cpu", "cuda", "vulkan"]) {
      const server = resolve(root, "runtimes", backend, "runtime", "llama-server");
      try { await access(server); } catch { continue; }
      try {
        const { stdout } = await execute("ldd", [server], { timeout: 5000, maxBuffer: 65536 });
        const missing = stdout.split(/\r?\n/).filter(line => /not found/.test(line)).map(line => line.trim().split(/\s+/)[0]!).filter(Boolean);
        runtimeLibraries.push({ backend, missing });
      } catch { /* ldd is absent on some images; that is not itself a fault. */ }
    }
  }
  const unresolved = runtimeLibraries.flatMap(entry => entry.missing);
  return {
    product: "EXCESS", kind: "local_diagnostics", protocolVersion: 1,
    platform: os.platform(), release: os.release(), architecture: os.arch(),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown", logicalCpus: os.cpus().length,
    memoryBytes: String(os.totalmem()), nvidia, temperatures: await observeTemperatures(),
    ...(runtimeLibraries.length ? { runtimeLibraries } : {}),
    executionBackends: [], verifiedCapabilities: [], registrationChecked: false,
    notes: ["Hardware discovery is not an execution probe.", "This command does not download models or accept jobs.", "Use probe for installed-model execution checks and status for local worker state; this inventory does not establish live supply.",
      ...(unresolved.length ? [`The installed runtime cannot load: ${[...new Set(unresolved)].join(", ")}. On Debian or Ubuntu run: sudo apt-get update && sudo apt-get install -y libgomp1`] : [])],
  };
}
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
async function controllerIdentity(path: string): Promise<{ origin: string; publicKey: string }> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16384) throw Error("CONTROLLER_IDENTITY_INVALID");
    const value = JSON.parse(await file.readFile("utf8")) as Record<string, unknown>;
    if (typeof value.origin !== "string" || typeof value.publicKey !== "string") throw Error("CONTROLLER_IDENTITY_INVALID");
    return { origin: value.origin, publicKey: value.publicKey };
  } finally { await file.close(); }
}
try {
  const command = process.argv[2], args = process.argv.slice(3);
  const flags = new Set(args.filter(arg => arg.startsWith("--"))), positional = args.filter(arg => !arg.startsWith("--"));
  const stateDir = resolve(process.env.EXCESS_WORKER_HOME ?? ".local/worker"), installDir = resolve(process.env.EXCESS_MODEL_DIR ?? ".local/ai");
  const path = resolve(stateDir, "identity.json");
  // --gpu selects only an isolated CUDA route. Vulkan entries remain catalogued, but isolated Vulkan execution is refused.
  const gpuBackend = (): Backend => {
    if (process.platform === "win32" || process.platform === "linux") return "cuda";
    throw Error("GPU_ISOLATION_UNVERIFIED: no isolated GPU profile is available on this operating system");
  };
  const chosenBackend = (fallback: Backend): Backend => flags.has("--gpu") ? gpuBackend() : flags.has("--cpu") ? "cpu" : fallback;
  if (command === "doctor") print(await diagnostics());
  else if (command === "pair") {
    let exists = false;
    try { await access(path); exists = true; } catch { /* New identity. */ }
    if (exists) throw Error("Device identity already exists; use complete-pairing or heartbeat, or excess-worker unpair to pair this computer again");
    const origin = process.argv[3] ?? "http://127.0.0.1:4310";
    const result = await beginPairing(origin, process.argv[4] ?? os.hostname());
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeIdentity(path, result.identity);
    if (process.platform === "linux" && origin.startsWith("https://")) await saveControllerOrigin(stateDir, origin, result.identity.publicKey);
    print({ product: "EXCESS", code: result.code, fingerprint: result.fingerprint, expiresAt: result.expiresAt, identityFile: path,
      next: "Approve this code and fingerprint with your wallet, then run complete-pairing." });
  } else if (command === "complete-pairing") process.stdout.write(JSON.stringify(await finishPairing(path)) + "\n");
  else if (command === "unpair") {
    const result = await unpairDevice(stateDir);
    print({ product: "EXCESS", ...result, next: result.retired ? "Revoke the old device on the Supply page if it is still listed, then: excess-worker pair <exchange address> \"<device name>\""
      : "Nothing to unpair; excess-worker pair <exchange address> \"<device name>\" pairs this computer" });
  }
  else if (command === "heartbeat") process.stdout.write(JSON.stringify(await sendHeartbeat(path)) + "\n");
  else if (command === "models") {
    // Estimate RAM/VRAM size separately from implemented, selectable and verified execution profiles.
    const [policy, installed, hardware] = await Promise.all([readWorkerPolicy(stateDir), installedComponents(installDir), detectHardware()]);
    const runtimesInstalled = { "llama.cpp": installed.runtimes, "stable-diffusion.cpp": installed.sdRuntimes };
    const catalog = servedModels(), rated = modelsByFit(catalog, hardware);
    const memoryFitting = rated.filter(item => item.fit.fits !== "no"), selectableFitting = modelsBySelectableFit(catalog, hardware);
    print({ product: "EXCESS", hardware, active: { model: policy.model, backend: policy.backend }, runtimesInstalled,
      // Preserve the existing lists as memory-estimate aliases for callers that already consume them.
      fitsThisComputer: memoryFitting.map(item => item.entry.id),
      tooLargeForThisComputer: rated.filter(item => item.fit.fits === "no").map(item => item.entry.id),
      memoryFitEstimate: { fitsThisComputer: memoryFitting.map(item => item.entry.id), tooLargeForEstimate: rated.filter(item => item.fit.fits === "no").map(item => item.entry.id) },
      selectableProfileFits: selectableFitting.map(item => item.entry.id),
      models: rated.map(({ entry, fit }) => ({ id: entry.id, kind: entry.kind, name: entry.displayName, parameters: entry.parameters, quantization: entry.quantization,
        meteringUnit: entry.meteringUnit, pricedPer: priceUnit(entry.kind).label, runtime: entry.engine, reasoning: entry.reasoning,
        downloadBytes: entry.downloadBytes, licence: entry.licence, installed: installed.models.includes(entry.id), gpuOnly: entry.gpuOnly,
        executionEvidence: "not established by catalogue inventory", memoryFitEstimate: fit, executionProfiles: modelExecutionProfiles(entry), ...fit })),
      next: "excess-worker use <model id> [--gpu], then excess-worker install-model <model id> [--gpu] --accept-download --accept-licenses (or excess-worker import <model id> <file.gguf ...> --accept-licenses if you already have the exact file)",
      note: "Kinds: text (streamed), embedding, transcription and image (buffered). fitsThisComputer, tooLargeForThisComputer and the row fields fits/cpu/gpu are legacy memory-size estimates only; they do not establish a selectable or verified execution profile. Use memoryFitEstimate and executionProfiles for those separate facts. GPU memory is read from nvidia-smi; other GPUs are not measured. Windows media CPU routes are implemented; embedding and image profiles require explicit measured host budgets. Windows image CUDA still requires a pinned authenticated GPU runtime. Windows CUDA llama-model selection has a 32 GB maximum budget and requires full observed offload. Published 0.1.0 CUDA evidence applies only to Qwen3 4B on the recorded RTX 3070 Ti and driver 596.49 configuration. Linux --gpu selects implemented CUDA support in a new, unverified Worker 0.2.0 candidate: NVIDIA SM90, CUDA 12.9, driver 580 or newer, helper ABI 6 and kernel 6.12 or newer are required. The published 0.1.0 Linux archive remains CPU-only. Vulkan catalog/runtime entries remain visible, but isolated Vulkan execution is refused. gpuOnly models never run on the CPU. Reasoning models think before answering, and those tokens are billed as output. The worker's local check decides whether a model can be served." });
  } else if (command === "use") {
    if (positional.length !== 1) throw Error("Usage: worker use <model id> [--gpu | --cpu]");
    const current = await readWorkerPolicy(stateDir), entry = servedModel(positional[0]!);
    if (entry.gpuOnly && flags.has("--cpu")) throw Error("This model runs on a GPU only; use --gpu");
    const backend = entry.gpuOnly ? gpuBackend() : chosenBackend("cpu");
    const selectedProfile = executionProfile(entry, backend);
    if (backend === "cuda" && !selectedProfile.selectable && process.platform === "win32")
      throw Error("GPU_PROFILE_UNVERIFIED: This Windows CUDA model/runtime profile is unavailable.");
    if (!selectedProfile.selectable) throw Error("MODEL_EXECUTION_PROFILE_UNAVAILABLE: " + (selectedProfile.note ?? "No isolated worker profile is implemented for this selection."));
    const budgetProblems = selectionBudgetProblems(entry, backend, current);
    if (budgetProblems.length) throw Error("MODEL_RESOURCE_BUDGET_REQUIRED: " + budgetProblems.join(" "));
    const policy = await writeWorkerPolicy(stateDir, { ...current, model: entry.id, backend });
    const linuxGpuCandidate = backend === "cuda" && process.platform === "linux";
    print({ product: "EXCESS", policy, kind: entry.kind, executionEvidence: "not established by catalogue inventory", executionProfile: selectedProfile,
      ...(linuxGpuCandidate ? { candidate: "unverified Linux CUDA profile; new Worker 0.2.0 binary and actual hardware trial required; published 0.1.0 Linux archive remains CPU-only" } : {}),
      next: `excess-worker install-model ${entry.id}${backend !== "cpu" ? " --gpu" : ""} --accept-download --accept-licenses (if not installed), then excess-worker offer <SYMBOL> <price per ${priceUnit(entry.kind).label}>. Resource caps stay at their configured values.` });
  } else if (command === "model-plan") {
    const policy = await readWorkerPolicy(stateDir), id = positional[0] ?? policy.model, backend = chosenBackend(policy.backend), entry = servedModel(id), text = entry.kind === "text";
    const plan = text ? textInstallationPlan(installDir, id, backend) : mediaInstallationPlan(installDir, id, backend);
    const disk = await (text ? textInstallDiskCheck(installDir, id, backend) : mediaInstallDiskCheck(installDir, id, backend)).catch(() => null);
    print({ ...plan, disk, ...modelPlanStatus(entry, backend, process.platform, plan.requiresExplicitConsent, disk?.sufficient ?? null) });
  } else if (command === "install-model") {
    if (!flags.has("--accept-download") || !flags.has("--accept-licenses") || positional.length > 1)
      throw Error("Read worker model-plan, then use install-model [model id] [--gpu] --accept-download --accept-licenses to opt in");
    const policy = await readWorkerPolicy(stateDir), id = positional[0] ?? policy.model;
    const disk = await (servedModel(id).kind === "text" ? textInstallDiskCheck(installDir, id, chosenBackend(policy.backend)) : mediaInstallDiskCheck(installDir, id, chosenBackend(policy.backend)));
    if (!disk.sufficient) throw Error(diskMessage(disk));
    // The packaged launcher points EXCESS_REDIST_DIR at the bundled Visual C++ runtime files.
    const install = { consent: true as const, modelId: id, backend: chosenBackend(policy.backend),
      ...(process.env.EXCESS_REDIST_DIR ? { redistDirectory: resolve(process.env.EXCESS_REDIST_DIR) } : {}),
      onProgress: (value: unknown) => process.stdout.write(JSON.stringify({ product: "EXCESS", download: value }) + "\n") };
    print(servedModel(id).kind === "text" ? await installTextAdapter(installDir, install) : await installMediaModel(installDir, install));
  } else if (command === "import") {
    // Files the supplier already has (LM Studio, llama.cpp downloads) are checked byte for byte against the pinned entry.
    if (positional.length < 2 || !flags.has("--accept-licenses")) throw Error("Usage: worker import <model id> <file.gguf> [more split parts...] --accept-licenses");
    const id = servedModel(positional[0]!).id;
    let result;
    try { result = await importModelFiles(installDir, id, positional.slice(1), { consent: true, onProgress: value => process.stdout.write(JSON.stringify({ product: "EXCESS", download: value }) + "\n") }); }
    catch (error) { if ((error as { code?: string }).code === "INSUFFICIENT_DISK_SPACE") throw Error("INSUFFICIENT_DISK_SPACE: copying these files needs more free space on the model drive; put them on the same drive as EXCESS_MODEL_DIR so they can be hard-linked"); throw error; }
    print({ product: "EXCESS", ...result,
      next: result.installed ? `excess-worker use ${id} [--gpu], then excess-worker install-model ${id} [--gpu] --accept-download --accept-licenses (downloads only what is still missing, such as the runtime), then excess-worker offer <SYMBOL> <price>`
        : `Add the missing files: excess-worker import ${id} <every part> --accept-licenses` });
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
    print(await workerGuide(path, stateDir, installDir, await detectHardware()));
  } else if (command === "offer") {
    const policy = await readWorkerPolicy(stateDir), unit = priceUnit(servedModel(policy.model).kind);
    const origin = async () => (JSON.parse(await readFile(path, "utf8")) as { origin: string }).origin;
    const isAssetId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    if (positional.length === 0) print({ product: "EXCESS", model: policy.model, pricedPer: unit.label, offers: await readWorkerOffers(stateDir, policy.model) });
    else if (positional.length === 3 && positional[1] === "band" && positional[2] === "off") {
      const target=positional[0]!,assetId=isAssetId(target)?target:(await assetFromSymbol(await origin(),target)).id;
      print({product:"EXCESS",model:policy.model,pricedPer:unit.label,offers:await clearWorkerPriceBand(stateDir,assetId,policy.model)});
    } else if(positional.length===4&&positional[1]==="band") {
      const target=positional[0]!,assetId=isAssetId(target)?target:(await assetFromSymbol(await origin(),target)).id;
      const unitPrice=async(value:string)=>isAssetId(target)?value:(await offerFromSymbol(await origin(),target,value,unit)).netUnits;
      const offers=await setWorkerPriceBand(stateDir,assetId,await unitPrice(positional[2]!),await unitPrice(positional[3]!),policy.model);
      print({product:"EXCESS",model:policy.model,pricedPer:unit.label,offer:offers.find(item=>item.assetId===assetId),offers,
        next:"Later offer price changes outside this interval are refused locally. Use offer <ASSET> band off to clear it."});
    } else if(positional.length===3&&positional[1]==="auto"&&["on","off"].includes(positional[2]!)) {
      const target=positional[0]!,assetId=isAssetId(target)?target:(await assetFromSymbol(await origin(),target)).id;
      const offers=await setWorkerAutoPrice(stateDir,assetId,positional[2]==="on",policy.model);
      print({product:"EXCESS",model:policy.model,pricedPer:unit.label,offer:offers.find(item=>item.assetId===assetId),offers,
        next:"The running worker reads the public market before renewal. It can lower this ask only inside your saved price band."});
    }
    else if (positional.length === 2 && positional[1] === "off") {
      // Withdraws the price in one asset; prices in other assets stay.
      const target = positional[0]!, assetId = isAssetId(target) ? target : (await assetFromSymbol(await origin(), target)).id;
      print({ product: "EXCESS", model: policy.model, pricedPer: unit.label, removed: assetId, offers: await removeWorkerOffer(stateDir, assetId, policy.model),
        next: "The worker stops renewing that offer; buyers can no longer pick it once it lapses, within a few minutes." });
    } else if (positional.length === 2) {
      const [target, price] = [positional[0]!, positional[1]!];
      // An asset ID takes exact base units per metering unit; a symbol takes a human price per million tokens, audio hour or image.
      // Each asset has its own price: setting one replaces only the price in that asset.
      const input = isAssetId(target) ? { assetId: target, netUnits: price } : await offerFromSymbol(await origin(), target, price, unit);
      const offers = await writeWorkerOffer(stateDir, input, policy.model);
      print({ product: "EXCESS", model: policy.model, pricedPer: unit.label, offer: offers.find(item => item.assetId === input.assetId), offers,
        next: `While running, the worker publishes these net prices per ${unit.unit} for the selected model, one offer per asset, after its local probe passes. A running worker picks up a change within 30 seconds.` });
    } else throw Error("Usage: worker offer [SYMBOL pricePerMillionTokens|pricePerAudioHour|pricePerImage | assetId netUnitsPerMeteringUnit | SYMBOL|assetId off | SYMBOL|assetId band floor ceiling | SYMBOL|assetId band off | SYMBOL|assetId auto on|off]");
  } else if (command === "status") print({ product: "EXCESS", ...await readWorkerStatus(stateDir) });
  else if (command === "drain" || command === "stop-now") {
    await setWorkerControl(stateDir, command === "drain" ? "drain" : "stop");
    process.stdout.write(JSON.stringify({ product: "EXCESS", requested: command, status: await readWorkerStatus(stateDir) }) + "\n");
  } else if (command === "controller" && positional[0] === "setup") {
    if (process.platform !== "linux" || positional.length !== 2) throw Error("Usage: worker controller setup <paired HTTPS origin>");
    const identity = await controllerIdentity(path);
    if (positional[1] !== identity.origin) throw Error("Controller origin must match the paired exchange");
    await chmod(stateDir, 0o700);
    await saveControllerOrigin(stateDir, positional[1], identity.publicKey);
    print({ product: "EXCESS", controller: "configured", origin: identity.origin });
  } else if (command === "run" || command === "resume") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    if (process.platform === "linux") {
      const identity = await controllerIdentity(path);
      const origin = await configuredControllerOrigin(stateDir, identity.origin, identity.publicKey);
      const packageDir = resolve(process.argv[1] ?? "", "..", "..", "..", "..");
      const policy = await readWorkerPolicy(stateDir), current = await currentRelease();
      const coordinatorFetch = createCoordinatorFetcher(origin);
      const cancellableFetch = (signal: AbortSignal): typeof fetch => (url, init) => coordinatorFetch(url, {
        ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      const updatePlan = createControllerUpdatePlan({ autoUpdate: policy.autoUpdate, supervised: supervisedBySystemd(), current,
        check: signal => checkForUpdate(origin, current, cancellableFetch(signal)),
        readControl: async signal => { signal.throwIfAborted(); return readWorkerControlRequest(stateDir); },
        install: (signal, revision) => startWorkerUpdate(stateDir, revision, () => {
          signal.throwIfAborted(); return runInstaller(origin, true, cancellableFetch(signal));
        }),
      });
      const run = await startLinuxController({ packageDir, installDir, stateDir, origin, signal: controller.signal,
        ...(updatePlan ? { updates: updatePlan.callbacks } : {}) });
      const result = await run.closed;
      const status = await readWorkerStatus(stateDir);
      print({ product: "EXCESS", ...status, controllerCleanup: result.cleaned });
      if (!result.cleaned || result.code !== 0) process.exitCode = 1;
      else process.exitCode = await updatePlan?.finish({ run: result, status, signal: controller.signal });
    } else if (process.platform === "win32") {
      const packageDir = resolve(process.argv[1] ?? "", "..", "..", "..", "..");
      const result = await runWindowsWorker({ packageDir, stateDir, installDir, signal: controller.signal });
      print({ product: "EXCESS", ...await readWorkerStatus(stateDir), controllerCleanup: result.cleaned });
      if (!result.cleaned || !result.reaped || result.exitCode !== 0) process.exitCode = 1;
    } else {
    await setWorkerControl(stateDir, "run");
    // The paired exchange is where updates come from; auto-install needs a supervisor to start the new version.
    let origin: string | undefined;
    try { origin = (JSON.parse(await readFile(path, "utf8")) as { origin?: string }).origin; } catch { /* runWorker reports a missing identity */ }
    const autoUpdate = (await readWorkerPolicy(stateDir)).autoUpdate;
    const update = origin?.startsWith("https://") ? { origin, current: await currentRelease(), autoInstall: autoUpdate && supervisedBySystemd() } : undefined;
    const result = await runWorker({ identityPath: path, stateDir, installDir, telemetry: observeLocalResources, signal: controller.signal, ...(update ? { update } : {}) });
    print({ product: "EXCESS", ...await readWorkerStatus(stateDir) });
    if (result.reason === "updated") process.exitCode = UPDATED_EXIT_CODE;
    }
  } else if (command === "service") print(await workerService(positional[0]));
  else if (command === "update") {
    if (flags.has("--auto")) {
      const choice = positional[0];
      if (choice !== "on" && choice !== "off") throw Error("Usage: worker update --auto on|off");
      const policy = await writeWorkerPolicy(stateDir, { ...await readWorkerPolicy(stateDir), autoUpdate: choice === "on" });
      print({ product: "EXCESS", autoUpdate: policy.autoUpdate,
        note: policy.autoUpdate ? "Installs new versions by itself when idle, while running as a Linux service (excess-worker service install). Elsewhere, run excess-worker update." : "Run excess-worker update to install new versions." });
    } else {
      const origin = (JSON.parse(await readFile(path, "utf8")) as { origin?: string }).origin ?? "";
      const check = await checkForUpdate(origin, await currentRelease());
      if (flags.has("--check") || (!check.available && !flags.has("--force"))) print({ product: "EXCESS", ...check });
      else {
        const code = await runInstaller(origin);
        if (code !== 0) throw Error(`The installer failed with exit code ${code}; the current version is unchanged`);
        print({ product: "EXCESS", installed: check.latest, previous: check.current,
          next: "Restart the worker to use it: excess-worker drain, then run it again. As a Linux service: systemctl --user restart excess-worker." });
      }
    }
  } else if (command === "schedule") {
    const current = await readWorkerPolicy(stateDir);
    const policy = positional.length === 0 ? current
      : await writeWorkerPolicy(stateDir, { ...current, schedule: positional.length === 1 && positional[0] === "off" ? [] : parseScheduleSpec(positional) });
    print({ product: "EXCESS", schedule: policy.schedule, runs: describeSchedule(policy.schedule) + (policy.schedule.length ? " (local time)" : ""),
      pauseOnBattery: policy.pauseOnBattery, note: "Outside these times, or on battery, the worker takes no new jobs; a running job finishes." });
  }
  else if (command === "thermal") {
    // excess-worker thermal [cpu <C|off>] [gpu <C|off>]
    const current = await readWorkerPolicy(stateDir), changes: Record<string, number | null> = {};
    if (positional.length % 2) throw Error("Usage: worker thermal [cpu <degrees C|off>] [gpu <degrees C|off>]");
    for (let index = 0; index < positional.length; index += 2) {
      const part = positional[index]!.toLowerCase(), value = positional[index + 1]!.toLowerCase();
      if (part !== "cpu" && part !== "gpu") throw Error("Usage: worker thermal [cpu <degrees C|off>] [gpu <degrees C|off>]");
      if (value !== "off" && !/^[0-9]{1,3}$/.test(value)) throw Error("A thermal limit is a whole number of degrees Celsius, or off");
      changes[part === "cpu" ? "maxCpuTempC" : "maxGpuTempC"] = value === "off" ? null : Number(value);
    }
    const policy = positional.length ? await writeWorkerPolicy(stateDir, { ...current, ...changes }) : current;
    print({ product: "EXCESS", maxCpuTempC: policy.maxCpuTempC, maxGpuTempC: policy.maxGpuTempC, readings: await observeTemperatures(),
      gpuChecked: policy.backend !== "cpu",
      note: `At a limit the worker takes no new jobs until the reading is below it; a running job is stopped at ${THERMAL_STOP_MARGIN_C} C over the limit. ` +
        "A reading of null means this computer exposes no sensor for it, and that limit cannot apply. A running worker picks up a change when it restarts." });
  }
  else if (command === "probe") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    print(await runLocalProbe({ stateDir, installDir, signal: controller.signal }));
  } else throw Error("Usage: worker guide | doctor | service install|remove|status | update [--check|--force|--auto on|off] | schedule [off | \"[days] HH:MM-HH:MM\" ...] | thermal [cpu <C|off>] [gpu <C|off>] | models | use <model id> [--gpu] | pair [origin] [label] | complete-pairing | unpair | heartbeat | model-plan [model id] [--gpu] | install-model [model id] [--gpu] --accept-download --accept-licenses | import <model id> <file.gguf ...> --accept-licenses | policy [file] | offer [SYMBOL price | assetId netUnitsPerMeteringUnit | SYMBOL off | SYMBOL|assetId band floor ceiling | SYMBOL|assetId band off] | status | run | drain | stop-now | resume | probe");
} catch (error) {
  const safe = error instanceof Error && !/private|secret|password/i.test(error.message) ? error.message : "Worker identity operation failed";
  // Only a system error code (such as EPERM or ENOSPC) is added; paths and messages stay out of the output.
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  process.stderr.write(safe + (typeof cause === "string" && /^E[A-Z]{2,16}$/.test(cause) ? " (" + cause + ")" : "") + "\n"); process.exitCode = 1;
}
