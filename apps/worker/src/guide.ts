import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readWorkerOffer } from "./offer.js";
import { readWorkerStatus } from "./control.js";

const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

/** Local onboarding state for a supplier: which setup steps are done and the next command to run.
 * It reads only local files and never contacts the coordinator or verifies model hashes. */
export async function workerGuide(identityPath: string, stateDir: string, installDir: string) {
  let identity: { origin?: string; deviceId?: string } | null = null;
  try { identity = JSON.parse(await readFile(identityPath, "utf8")); } catch { /* Not paired yet. */ }
  let offer = null;
  try { offer = await readWorkerOffer(stateDir); } catch { /* An unreadable offer is shown as not set. */ }
  let state: string | null = null;
  try { state = (await readWorkerStatus(stateDir)).state; } catch { /* Never run. */ }
  const steps = [
    { step: "pair", done: Boolean(identity?.deviceId),
      command: identity ? "excess-worker complete-pairing" : "excess-worker pair <exchange address, for example https://app.example> \"<device name>\"",
      note: identity ? "Approve the pairing code in the web app (Supplier, Pair a device) first." : "Prints a code to approve in the web app under Supplier, Pair a device." },
    { step: "install-model", done: await exists(join(resolve(installDir), "install.json")),
      command: "excess-worker model-plan, then excess-worker install-model --accept-download --accept-licenses",
      note: "Downloads about 660 MB of pinned, hash-checked files: llama.cpp (MIT) and Qwen3-0.6B (Apache-2.0). CPU only." },
    { step: "set-price", done: offer !== null, command: "excess-worker offer <ASSET SYMBOL> <price per million output tokens>",
      note: "You are paid this net price; buyers also pay the exchange fee. Your worker publishes it only after its local check passes." },
    { step: "run", done: state !== null && ["running", "idle", "blocked", "starting"].includes(state), command: "excess-worker run",
      note: "Keep it running to receive jobs. excess-worker drain finishes current work; excess-worker stop-now stops immediately." },
  ];
  return {
    product: "EXCESS", origin: identity?.origin ?? null, deviceId: identity?.deviceId ?? null, steps,
    next: steps.find(step => !step.done)?.step ?? "done",
    disclosure: "Jobs run on this computer, and you can see their prompts and outputs. Earnings become withdrawable after the review window.",
  };
}
