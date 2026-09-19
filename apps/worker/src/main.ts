import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beginPairing, writeIdentity, finishPairing, sendHeartbeat } from "./identity.js";
import { textInstallationPlan, installTextAdapter, installMediaModel, mediaInstallationPlan, installedComponents, textInstallDiskCheck, mediaInstallDiskCheck, importModelFiles, type Backend, type DiskCheck } from "@excess/adapters";
import { priceUnit, servedModel, servedModels } from "./served.js";
import { runWorker } from "./runtime.js";
import { readWorkerStatus, setWorkerControl } from "./control.js";
import { describeSchedule, parseScheduleSpec, readWorkerPolicy, writeWorkerPolicy } from "./policy.js";
import { observeLocalResources } from "./telemetry.js";
import { runLocalProbe } from "./probe.js";
import { readWorkerOffer, writeWorkerOffer, offerFromSymbol } from "./offer.js";
import { workerGuide } from "./guide.js";
import { detectHardware, modelsByFit } from "./hardware.js";
import { workerService } from "./service.js";
import { checkForUpdate, currentRelease, runInstaller, supervisedBySystemd, UPDATED_EXIT_CODE } from "./update.js";
const execute = promisify(execFile);
const gigabytes = (bytes: number) => (bytes / 1073741824).toFixed(1) + " GB";
const diskMessage = (disk: DiskCheck) => `INSUFFICIENT_DISK_SPACE: this install needs ${gigabytes(disk.requiredBytes)} free on the model drive and ${gigabytes(disk.freeBytes ?? 0)} is free. Free space or set EXCESS_MODEL_DIR to a larger drive.`;
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
    for (const backend of ["cpu", "gpu"]) {
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
    memoryBytes: String(os.totalmem()), nvidia,
    ...(runtimeLibraries.length ? { runtimeLibraries } : {}),
    executionBackends: [], verifiedCapabilities: [], registrationChecked: false,
    notes: ["Hardware discovery is not an execution probe.", "This command does not download models or accept jobs.", "Use probe for installed-model execution checks and status for local worker state; this inventory does not establish live supply.",
      ...(unresolved.length ? [`The installed runtime cannot load: ${[...new Set(unresolved)].join(", ")}. On Debian or Ubuntu run: sudo apt-get update && sudo apt-get install -y libgomp1`] : [])],
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
    // What this computer can run: system memory for CPU inference, NVIDIA GPU memory for full offload. Models that fit come first.
    const [policy, installed, hardware] = await Promise.all([readWorkerPolicy(stateDir), installedComponents(installDir), detectHardware()]);
    const runtimesInstalled = { "llama.cpp": installed.runtimes, "stable-diffusion.cpp": installed.sdRuntimes };
    const rated = modelsByFit(servedModels(), hardware);
    print({ product: "EXCESS", hardware, active: { model: policy.model, backend: policy.backend }, runtimesInstalled,
      fitsThisComputer: rated.filter(item => item.fit.fits !== "no").map(item => item.entry.id),
      tooLargeForThisComputer: rated.filter(item => item.fit.fits === "no").map(item => item.entry.id),
      models: rated.map(({ entry, fit }) => ({ id: entry.id, kind: entry.kind, name: entry.displayName, parameters: entry.parameters, quantization: entry.quantization,
        meteringUnit: entry.meteringUnit, pricedPer: priceUnit(entry.kind).label, runtime: entry.engine, reasoning: entry.reasoning,
        downloadBytes: entry.downloadBytes, installed: installed.models.includes(entry.id), gpuOnly: entry.gpuOnly, ...fit })),
      next: "excess-worker use <model id> [--gpu], then excess-worker install-model <model id> [--gpu] --accept-download --accept-licenses (or excess-worker import <model id> <file.gguf ...> --accept-licenses if you already have the exact file)",
      note: "Kinds: text (streamed), embedding, transcription and image (buffered). fits says where a model fits: gpu, cpu, gpu or cpu, or no. GPU memory is read from nvidia-smi; other GPUs are not measured. GPU mode needs an NVIDIA GPU with a current driver on Windows or a Vulkan driver on Linux; gpuOnly models never run on the CPU. Reasoning models think before answering, and those tokens are billed as output. Fit estimates are guidance; the worker's local check decides." });
  } else if (command === "use") {
    if (positional.length !== 1) throw Error("Usage: worker use <model id> [--gpu | --cpu]");
    const current = await readWorkerPolicy(stateDir), entry = servedModel(positional[0]!);
    if (entry.gpuOnly && flags.has("--cpu")) throw Error("This model runs on a GPU only; use --gpu");
    const backend = entry.gpuOnly ? gpuBackend : chosenBackend("cpu");
    const policy = await writeWorkerPolicy(stateDir, { ...current, model: entry.id, backend,
      maxMemoryMb: backend === "cpu" ? Math.max(current.maxMemoryMb, entry.minMemoryMb) : current.maxMemoryMb });
    print({ product: "EXCESS", policy, kind: entry.kind, next: `excess-worker install-model ${entry.id}${backend !== "cpu" ? " --gpu" : ""} --accept-download --accept-licenses (if not installed), then excess-worker offer <SYMBOL> <price per ${priceUnit(entry.kind).label}>` });
  } else if (command === "model-plan") {
    const policy = await readWorkerPolicy(stateDir), id = positional[0] ?? policy.model, backend = chosenBackend(policy.backend), text = servedModel(id).kind === "text";
    const plan = text ? textInstallationPlan(installDir, id, backend) : mediaInstallationPlan(installDir, id, backend);
    print({ ...plan, disk: await (text ? textInstallDiskCheck(installDir, id, backend) : mediaInstallDiskCheck(installDir, id, backend)).catch(() => null) });
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
    // The paired exchange is where updates come from; auto-install needs a supervisor to start the new version.
    let origin: string | undefined;
    try { origin = (JSON.parse(await readFile(path, "utf8")) as { origin?: string }).origin; } catch { /* runWorker reports a missing identity */ }
    const autoUpdate = (await readWorkerPolicy(stateDir)).autoUpdate;
    const update = origin?.startsWith("https://") ? { origin, current: await currentRelease(), autoInstall: autoUpdate && supervisedBySystemd() } : undefined;
    const result = await runWorker({ identityPath: path, stateDir, installDir, telemetry: observeLocalResources, signal: controller.signal, ...(update ? { update } : {}) });
    print({ product: "EXCESS", ...await readWorkerStatus(stateDir) });
    if (result.reason === "updated") process.exitCode = UPDATED_EXIT_CODE;
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
  else if (command === "probe") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
    print(await runLocalProbe({ stateDir, installDir, signal: controller.signal }));
  } else throw Error("Usage: worker guide | doctor | service install|remove|status | update [--check|--force|--auto on|off] | schedule [off | \"[days] HH:MM-HH:MM\" ...] | models | use <model id> [--gpu] | pair [origin] [label] | complete-pairing | heartbeat | model-plan [model id] [--gpu] | install-model [model id] [--gpu] --accept-download --accept-licenses | import <model id> <file.gguf ...> --accept-licenses | policy [file] | offer [SYMBOL price | assetId netUnitsPerMeteringUnit] | status | run | drain | stop-now | resume | probe");
} catch (error) {
  const safe = error instanceof Error && !/private|secret|password/i.test(error.message) ? error.message : "Worker identity operation failed";
  // Only a system error code (such as EPERM or ENOSPC) is added; paths and messages stay out of the output.
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  process.stderr.write(safe + (typeof cause === "string" && /^E[A-Z]{2,16}$/.test(cause) ? " (" + cause + ")" : "") + "\n"); process.exitCode = 1;
}
