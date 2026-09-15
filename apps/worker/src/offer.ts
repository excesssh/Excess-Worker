import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** The supplier's public ask for one catalog model: net base units per metering unit (output token, input token,
 * audio second or image) in one asset. */
export type WorkerOffer = { assetId: string; netUnits: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseWorkerOffer(input: unknown): WorkerOffer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker offer");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.assetId !== "string" || typeof value.netUnits !== "string" ||
      !uuid.test(value.assetId) || !/^[1-9][0-9]{0,30}$/.test(value.netUnits)) throw Error("Invalid worker offer");
  return { assetId: value.assetId, netUnits: value.netUnits };
}
// Each model has its own price: offers/<model id>.json.
function offerPath(stateDir: string, modelId: string) {
  if (![...MODEL_CATALOG, ...MEDIA_CATALOG].some(entry => entry.id === modelId)) throw Error("Unknown model");
  return join(resolve(stateDir), "offers", modelId + ".json");
}
export async function readWorkerOffer(stateDir: string, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer | null> {
  try { return parseWorkerOffer(JSON.parse(await readPrivateText(offerPath(stateDir, modelId), 1024))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** Converts a human price per `unit.perUnits` metering units (a million tokens, an audio hour of 3,600 seconds, one image)
 * in an asset listed on the coordinator's public market into the offer's exact net base units per metering unit.
 * Fractional base units are refused. */
export async function offerFromSymbol(origin: string, symbol: string, price: string, unit: { perUnits: bigint; label: string } = { perUnits: 1_000_000n, label: "million tokens" }): Promise<WorkerOffer> {
  let response: Response;
  try { response = await fetch(new URL("/v1/market", origin), { redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw Error("The exchange market is unavailable"); }
  if (!response.ok) throw Error("The exchange market is unavailable");
  const market = await response.json() as { markets?: { asset: { id: string; symbol: string; decimals: number } }[]; models?: { markets: { asset: { id: string; symbol: string; decimals: number } }[] }[] };
  const assets = new Map<string, { id: string; symbol: string; decimals: number }>();
  for (const item of [...(market.markets ?? []), ...(market.models ?? []).flatMap(model => model.markets)]) assets.set(item.asset.id, item.asset);
  const matches = [...assets.values()].filter(asset => asset.symbol.toUpperCase() === symbol.toUpperCase());
  if (matches.length !== 1) throw Error("Unknown or ambiguous asset symbol for this exchange");
  const { id, decimals } = matches[0]!;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw Error("Unsupported asset decimals");
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,36})?$/.test(price)) throw Error("Price must be a plain decimal number");
  if (typeof unit.perUnits !== "bigint" || unit.perUnits < 1n) throw Error("Invalid price unit");
  const [whole, fraction = ""] = price.split(".");
  if (fraction.length > decimals) throw Error("Price has more decimal places than the asset supports");
  const perPrice = BigInt(whole! + fraction.padEnd(decimals, "0"));
  if (perPrice === 0n || perPrice % unit.perUnits !== 0n) {
    const step = unit.perUnits, scale = 10n ** BigInt(decimals);
    const human = decimals === 0 ? String(step) : (step / scale).toString() + (step % scale ? "." + (step % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "");
    throw Error(`Price per ${unit.label} must be a positive multiple of ${human} ${matches[0]!.symbol}`);
  }
  return parseWorkerOffer({ assetId: id, netUnits: String(perPrice / unit.perUnits) });
}
export async function writeWorkerOffer(stateDir: string, input: unknown, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer> {
  const offer = parseWorkerOffer(input), path = offerPath(stateDir, modelId);
  await mkdir(join(resolve(stateDir), "offers"), { recursive: true });
  await atomicPrivateJson(path, offer);
  return offer;
}
