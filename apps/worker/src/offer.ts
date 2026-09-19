import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";
import { PRICE_DECIMALS, PRICE_PATTERN, formatPrice, priceMicros } from "@excess/protocol";
import { atomicPrivateJson, readPrivateText } from "./control.js";

/** The supplier's public ask for one catalog model: net base units per metering unit (output token, input token,
 * audio second or image) in one asset, a price with up to six fractional digits (below one base unit is allowed). */
export type WorkerOffer = { assetId: string; netUnits: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseWorkerOffer(input: unknown): WorkerOffer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker offer");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.assetId !== "string" || typeof value.netUnits !== "string" ||
      !uuid.test(value.assetId) || value.netUnits.length > 40 || !PRICE_PATTERN.test(value.netUnits) || priceMicros(value.netUnits) === 0n) throw Error("Invalid worker offer");
  return { assetId: value.assetId, netUnits: value.netUnits };
}
/** At most this many assets priced for one model. */
export const MAX_WORKER_OFFERS = 8;
/** A model's prices, at most one per asset: `{offers:[...]}`, or a single offer as written by earlier workers. */
export function parseWorkerOffers(input: unknown): WorkerOffer[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker offer");
  const value = input as Record<string, unknown>;
  if (!("offers" in value)) return [parseWorkerOffer(value)];
  if (Object.keys(value).length !== 1 || !Array.isArray(value.offers) || value.offers.length < 1 || value.offers.length > MAX_WORKER_OFFERS) throw Error("Invalid worker offer");
  const offers = value.offers.map(parseWorkerOffer);
  if (new Set(offers.map(offer => offer.assetId)).size !== offers.length) throw Error("Invalid worker offer");
  return offers;
}
// Each model has its own prices: offers/<model id>.json.
function offerPath(stateDir: string, modelId: string) {
  if (![...MODEL_CATALOG, ...MEDIA_CATALOG].some(entry => entry.id === modelId)) throw Error("Unknown model");
  return join(resolve(stateDir), "offers", modelId + ".json");
}
/** The model's prices, one per asset; empty when none is set. */
export async function readWorkerOffers(stateDir: string, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer[]> {
  try { return parseWorkerOffers(JSON.parse(await readPrivateText(offerPath(stateDir, modelId), 4096))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
/** The asset with this symbol on the coordinator's public market. */
export async function assetFromSymbol(origin: string, symbol: string): Promise<{ id: string; symbol: string; decimals: number }> {
  let response: Response;
  try { response = await fetch(new URL("/v1/market", origin), { redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw Error("The exchange market is unavailable"); }
  if (!response.ok) throw Error("The exchange market is unavailable");
  const market = await response.json() as { markets?: { asset: { id: string; symbol: string; decimals: number } }[]; models?: { markets: { asset: { id: string; symbol: string; decimals: number } }[] }[] };
  const assets = new Map<string, { id: string; symbol: string; decimals: number }>();
  for (const item of [...(market.markets ?? []), ...(market.models ?? []).flatMap(model => model.markets)]) assets.set(item.asset.id, item.asset);
  const matches = [...assets.values()].filter(asset => asset.symbol.toUpperCase() === symbol.toUpperCase());
  if (matches.length !== 1) throw Error("Unknown or ambiguous asset symbol for this exchange");
  if (!uuid.test(matches[0]!.id)) throw Error("Invalid asset on this exchange");
  return matches[0]!;
}
/** Converts a human price per `unit.perUnits` metering units (a million tokens, an audio hour of 3,600 seconds, one image)
 * in an asset listed on the coordinator's public market into the offer's exact net price per metering unit, which may be
 * below one base unit but has at most six fractional digits; a price that would need more is refused with its step. */
export async function offerFromSymbol(origin: string, symbol: string, price: string, unit: { perUnits: bigint; label: string } = { perUnits: 1_000_000n, label: "million tokens" }): Promise<WorkerOffer> {
  const asset = await assetFromSymbol(origin, symbol), { id, decimals } = asset;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw Error("Unsupported asset decimals");
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,36})?$/.test(price)) throw Error("Price must be a plain decimal number");
  if (typeof unit.perUnits !== "bigint" || unit.perUnits < 1n) throw Error("Invalid price unit");
  const [whole, fraction = ""] = price.split(".");
  if (fraction.length > decimals) throw Error("Price has more decimal places than the asset supports");
  const perPrice = BigInt(whole! + fraction.padEnd(decimals, "0")), micros = perPrice * 10n ** BigInt(PRICE_DECIMALS);
  if (perPrice === 0n || micros % unit.perUnits !== 0n) {
    const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
    const step = unit.perUnits / gcd(unit.perUnits, 10n ** BigInt(PRICE_DECIMALS)), scale = 10n ** BigInt(decimals);
    const human = decimals === 0 ? String(step) : (step / scale).toString() + (step % scale ? "." + (step % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "");
    throw Error(`Price per ${unit.label} must be a positive multiple of ${human} ${asset.symbol}`);
  }
  return parseWorkerOffer({ assetId: id, netUnits: formatPrice(micros / unit.perUnits) });
}
/** Sets the model's price in the offer's asset, replacing any earlier price in that asset and keeping the others.
 * Returns every price now set for the model. */
export async function writeWorkerOffer(stateDir: string, input: unknown, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer[]> {
  const offer = parseWorkerOffer(input), path = offerPath(stateDir, modelId);
  const offers = [...(await readWorkerOffers(stateDir, modelId)).filter(item => item.assetId !== offer.assetId), offer];
  if (offers.length > MAX_WORKER_OFFERS) throw Error(`A model can be priced in at most ${MAX_WORKER_OFFERS} assets`);
  await mkdir(join(resolve(stateDir), "offers"), { recursive: true });
  await atomicPrivateJson(path, { offers });
  return offers;
}
/** Withdraws the model's price in one asset; the worker stops renewing that offer and it lapses. Returns the prices left. */
export async function removeWorkerOffer(stateDir: string, assetId: string, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer[]> {
  if (!uuid.test(assetId)) throw Error("Invalid asset");
  const path = offerPath(stateDir, modelId), offers = (await readWorkerOffers(stateDir, modelId)).filter(item => item.assetId !== assetId);
  if (offers.length) await atomicPrivateJson(path, { offers });
  else await rm(path, { force: true });
  return offers;
}
