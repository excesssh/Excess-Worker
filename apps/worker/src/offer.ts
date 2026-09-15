import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** The supplier's public ask for the pinned model: net base units per output token in one asset. */
export type WorkerOffer = { assetId: string; netUnits: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseWorkerOffer(input: unknown): WorkerOffer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker offer");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.assetId !== "string" || typeof value.netUnits !== "string" ||
      !uuid.test(value.assetId) || !/^[1-9][0-9]{0,30}$/.test(value.netUnits)) throw Error("Invalid worker offer");
  return { assetId: value.assetId, netUnits: value.netUnits };
}
export async function readWorkerOffer(stateDir: string): Promise<WorkerOffer | null> {
  try { return parseWorkerOffer(JSON.parse(await readPrivateText(join(resolve(stateDir), "offer.json"), 1024))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeWorkerOffer(stateDir: string, input: unknown): Promise<WorkerOffer> {
  const offer = parseWorkerOffer(input);
  await mkdir(resolve(stateDir), { recursive: true });
  await atomicPrivateJson(join(resolve(stateDir), "offer.json"), offer);
  return offer;
}
