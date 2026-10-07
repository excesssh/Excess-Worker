import { readFile } from "node:fs/promises";
import { installedComponents } from "@excess/adapters";
import { readWorkerOffers } from "./offer.js";
import { readWorkerStatus } from "./control.js";
import { readWorkerPolicy } from "./policy.js";
import { priceUnit, servedModel, servedModels } from "./served.js";
import { largestSelectableTextModel, modelExecutionProfiles, modelsByFit, modelsBySelectableFit, type Hardware } from "./hardware.js";

const WORK: Record<string, string> = {
  text: "Serving text jobs (streamed answers, paid per output token)",
  embedding: "Serving embedding jobs (vectors for search, paid per input token)",
  transcription: "Serving speech-to-text jobs (WAV audio in, transcript out, paid per audio second)",
  image: "Serving image jobs (PNG images, paid per image)",
};
/** Local onboarding state for a supplier: which setup steps are done and the next command to run.
 * It reads only local files and never contacts the coordinator or verifies model hashes. */
export async function workerGuide(identityPath: string, stateDir: string, installDir: string, hardware: Hardware = { memoryMb: 0, gpus: [] }) {
  let identity: { origin?: string; deviceId?: string } | null = null;
  try { identity = JSON.parse(await readFile(identityPath, "utf8")); } catch { /* Not paired yet. */ }
  const policy = await readWorkerPolicy(stateDir), served = servedModel(policy.model), unit = priceUnit(served.kind);
  let offers: unknown[] = [];
  try { offers = await readWorkerOffers(stateDir, policy.model); } catch { /* An unreadable offer is shown as not set. */ }
  let state: string | null = null;
  try { state = (await readWorkerStatus(stateDir)).state; } catch { /* Never run. */ }
  const installed = await installedComponents(installDir);
  const gpu = policy.backend !== "cpu" ? " --gpu" : "";
  const runtimeInstalled = (served.engine === "stable-diffusion.cpp" ? installed.sdRuntimes : installed.runtimes).includes(policy.backend);
  const hardwareName = policy.backend === "cuda" ? "an NVIDIA GPU" : policy.backend === "vulkan" ? "a GPU through Vulkan" : "the CPU";
  const catalog = servedModels(), rated = modelsByFit(catalog, hardware);
  const memoryFitting = rated.filter(item => item.fit.fits !== "no");
  const selectableFitting = modelsBySelectableFit(catalog, hardware);
  // Recommend only a memory estimate that has a selectable profile on this operating system.
  const suggestion = largestSelectableTextModel(catalog, hardware);
  const activeEstimate = rated.find(item => item.entry.id === served.id)!;
  const activeProfile = modelExecutionProfiles(served, process.platform)[policy.backend];
  const activeBackendMemoryFits = policy.backend === "cpu" ? activeEstimate.fit.cpu.fits :
    policy.backend === "cuda" ? activeEstimate.fit.gpu.fits : false;
  const activeWarning = !activeProfile.selectable ? ` ${served.id} has an unsupported ${policy.backend} execution profile on this platform.` :
    !activeBackendMemoryFits ? ` ${served.id} does not meet the memory-size estimate for its selected ${policy.backend} profile.` : "";
  // A revoked device (or one the exchange no longer accepts) is paired again after retiring its identity.
  const revoked = state === "revoked";
  const steps = [
    { step: "pair", done: Boolean(identity?.deviceId) && !revoked,
      command: revoked ? "excess-worker unpair, then excess-worker pair <exchange address> \"<device name>\""
        : identity ? "excess-worker complete-pairing" : "excess-worker pair <exchange address, for example https://excess.sh> \"<device name>\"",
      note: revoked ? "This device was revoked or its pairing is no longer accepted. unpair keeps the old identity and job journal in a dated folder."
        : identity ? "Approve the pairing code in the web app (Supply, Pair a device) first." : "Prints a code to approve in the web app under Supply, Pair a device." },
    { step: "choose-model", done: true, command: "excess-worker models, then excess-worker use <model id> [--gpu]",
      note: `${WORK[served.kind]}: ${served.displayName} on ${hardwareName}. ${memoryFitting.length} of ${rated.length} models meet the memory-size estimate; ${selectableFitting.length} also have a selectable profile that meets an estimate` +
        (suggestion ? `; the largest text model with a selectable profile and fitting estimate is ${suggestion.entry.id} via ${suggestion.executionProfile.backend} (${suggestion.executionProfile.verification.replaceAll("_", " ")}).` : `; no text model has a selectable profile that meets a memory estimate.`) +
        activeWarning },
    { step: "install-model", done: installed.models.includes(policy.model) && runtimeInstalled,
      command: `excess-worker install-model ${policy.model}${gpu} --accept-download --accept-licenses`,
      note: `Downloads pinned, hash-checked files: ${served.engine} (MIT) and ${served.displayName}, after checking free disk space. ` +
        `Already have the exact model file? excess-worker import ${policy.model} <file.gguf ...> --accept-licenses uses it instead of downloading it again.` },
    { step: "set-price", done: offers.length > 0, command: `excess-worker offer <ASSET SYMBOL> <price per ${unit.label}>`,
      note: `You are paid this net price per ${unit.label} for the selected model; buyers also pay the exchange fee. Your worker publishes it only after its local check passes. ` +
        "Run it once per asset to sell in several (for example USDG and ETH); excess-worker offer <ASSET SYMBOL> off withdraws one." },
    { step: "run", done: state !== null && ["running", "idle", "blocked", "starting"].includes(state), command: "excess-worker run",
      note: "Keep it running to receive jobs. excess-worker drain finishes current work; excess-worker stop-now stops immediately." +
        (process.platform === "linux" ? " On Linux, excess-worker service install runs it in the background as your own systemd service, including after a restart." : "") },
  ];
  return {
    product: "EXCESS", origin: identity?.origin ?? null, deviceId: identity?.deviceId ?? null, model: policy.model, kind: served.kind, backend: policy.backend, steps,
    next: steps.find(step => !step.done)?.step ?? "done",
    models: {
      // Keep the original fields as compatibility aliases for the memory-size estimate.
      fitsThisComputer: memoryFitting.map(item => item.entry.id), tooLargeForThisComputer: rated.filter(item => item.fit.fits === "no").map(item => item.entry.id),
      memoryFitEstimate: { fitsThisComputer: memoryFitting.map(item => item.entry.id), tooLargeForEstimate: rated.filter(item => item.fit.fits === "no").map(item => item.entry.id) },
      selectableProfileFits: selectableFitting.map(item => item.entry.id),
    },
    disclosure: served.kind === "text" ? "Jobs run on this computer, and you can see their prompts and outputs. Earnings become withdrawable after the review window."
      : "Jobs run on this computer, and you can see their inputs (texts, audio or prompts) and outputs. Earnings become withdrawable after the review window.",
  };
}
