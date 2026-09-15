import { readFile } from "node:fs/promises";
import { catalogEntry, installedComponents } from "@excess/adapters";
import { readWorkerOffer } from "./offer.js";
import { readWorkerStatus } from "./control.js";
import { readWorkerPolicy } from "./policy.js";

/** Local onboarding state for a supplier: which setup steps are done and the next command to run.
 * It reads only local files and never contacts the coordinator or verifies model hashes. */
export async function workerGuide(identityPath: string, stateDir: string, installDir: string) {
  let identity: { origin?: string; deviceId?: string } | null = null;
  try { identity = JSON.parse(await readFile(identityPath, "utf8")); } catch { /* Not paired yet. */ }
  const policy = await readWorkerPolicy(stateDir), entry = catalogEntry(policy.model);
  let offer = null;
  try { offer = await readWorkerOffer(stateDir, policy.model); } catch { /* An unreadable offer is shown as not set. */ }
  let state: string | null = null;
  try { state = (await readWorkerStatus(stateDir)).state; } catch { /* Never run. */ }
  const installed = await installedComponents(installDir);
  const gpu = policy.backend === "cuda" ? " --gpu" : "";
  const steps = [
    { step: "pair", done: Boolean(identity?.deviceId),
      command: identity ? "excess-worker complete-pairing" : "excess-worker pair <exchange address, for example https://excess.sh> \"<device name>\"",
      note: identity ? "Approve the pairing code in the web app (Supply, Pair a device) first." : "Prints a code to approve in the web app under Supply, Pair a device." },
    { step: "choose-model", done: true, command: "excess-worker models, then excess-worker use <model id> [--gpu]",
      note: `Serving ${entry.displayName} on ${policy.backend === "cuda" ? "an NVIDIA GPU" : "the CPU"}. Bigger models earn more per token but need more memory.` },
    { step: "install-model", done: installed.models.includes(policy.model) && installed.runtimes.includes(policy.backend),
      command: `excess-worker install-model ${policy.model}${gpu} --accept-download --accept-licenses`,
      note: "Downloads pinned, hash-checked files: llama.cpp (MIT) and the Qwen3 model (Apache-2.0)." },
    { step: "set-price", done: offer !== null, command: "excess-worker offer <ASSET SYMBOL> <price per million output tokens>",
      note: "You are paid this net price for the selected model; buyers also pay the exchange fee. Your worker publishes it only after its local check passes." },
    { step: "run", done: state !== null && ["running", "idle", "blocked", "starting"].includes(state), command: "excess-worker run",
      note: "Keep it running to receive jobs. excess-worker drain finishes current work; excess-worker stop-now stops immediately." },
  ];
  return {
    product: "EXCESS", origin: identity?.origin ?? null, deviceId: identity?.deviceId ?? null, model: policy.model, backend: policy.backend, steps,
    next: steps.find(step => !step.done)?.step ?? "done",
    disclosure: "Jobs run on this computer, and you can see their prompts and outputs. Earnings become withdrawable after the review window.",
  };
}
