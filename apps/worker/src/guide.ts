import { readFile } from "node:fs/promises";
import { installedComponents } from "@excess/adapters";
import { readWorkerOffer } from "./offer.js";
import { readWorkerStatus } from "./control.js";
import { readWorkerPolicy } from "./policy.js";
import { priceUnit, servedModel } from "./served.js";

const WORK: Record<string, string> = {
  text: "Serving text jobs (streamed answers, paid per output token)",
  embedding: "Serving embedding jobs (vectors for search, paid per input token)",
  transcription: "Serving speech-to-text jobs (WAV audio in, transcript out, paid per audio second)",
  image: "Serving image jobs (PNG images, paid per image)",
};
/** Local onboarding state for a supplier: which setup steps are done and the next command to run.
 * It reads only local files and never contacts the coordinator or verifies model hashes. */
export async function workerGuide(identityPath: string, stateDir: string, installDir: string) {
  let identity: { origin?: string; deviceId?: string } | null = null;
  try { identity = JSON.parse(await readFile(identityPath, "utf8")); } catch { /* Not paired yet. */ }
  const policy = await readWorkerPolicy(stateDir), served = servedModel(policy.model), unit = priceUnit(served.kind);
  let offer = null;
  try { offer = await readWorkerOffer(stateDir, policy.model); } catch { /* An unreadable offer is shown as not set. */ }
  let state: string | null = null;
  try { state = (await readWorkerStatus(stateDir)).state; } catch { /* Never run. */ }
  const installed = await installedComponents(installDir);
  const gpu = policy.backend !== "cpu" ? " --gpu" : "";
  const runtimeInstalled = (served.engine === "stable-diffusion.cpp" ? installed.sdRuntimes : installed.runtimes).includes(policy.backend);
  const hardware = policy.backend === "cuda" ? "an NVIDIA GPU" : policy.backend === "vulkan" ? "a GPU through Vulkan" : "the CPU";
  const steps = [
    { step: "pair", done: Boolean(identity?.deviceId),
      command: identity ? "excess-worker complete-pairing" : "excess-worker pair <exchange address, for example https://excess.sh> \"<device name>\"",
      note: identity ? "Approve the pairing code in the web app (Supply, Pair a device) first." : "Prints a code to approve in the web app under Supply, Pair a device." },
    { step: "choose-model", done: true, command: "excess-worker models, then excess-worker use <model id> [--gpu]",
      note: `${WORK[served.kind]}: ${served.displayName} on ${hardware}. Bigger models earn more but need more memory.` },
    { step: "install-model", done: installed.models.includes(policy.model) && runtimeInstalled,
      command: `excess-worker install-model ${policy.model}${gpu} --accept-download --accept-licenses`,
      note: `Downloads pinned, hash-checked files: ${served.engine} (MIT) and ${served.displayName}.` },
    { step: "set-price", done: offer !== null, command: `excess-worker offer <ASSET SYMBOL> <price per ${unit.label}>`,
      note: `You are paid this net price per ${unit.label} for the selected model; buyers also pay the exchange fee. Your worker publishes it only after its local check passes.` },
    { step: "run", done: state !== null && ["running", "idle", "blocked", "starting"].includes(state), command: "excess-worker run",
      note: "Keep it running to receive jobs. excess-worker drain finishes current work; excess-worker stop-now stops immediately." },
  ];
  return {
    product: "EXCESS", origin: identity?.origin ?? null, deviceId: identity?.deviceId ?? null, model: policy.model, kind: served.kind, backend: policy.backend, steps,
    next: steps.find(step => !step.done)?.step ?? "done",
    disclosure: served.kind === "text" ? "Jobs run on this computer, and you can see their prompts and outputs. Earnings become withdrawable after the review window."
      : "Jobs run on this computer, and you can see their inputs (texts, audio or prompts) and outputs. Earnings become withdrawable after the review window.",
  };
}
