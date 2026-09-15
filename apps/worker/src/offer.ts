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
/** Converts a human price per million output tokens in an asset listed on the coordinator's
 * public market into the offer's exact net base units per token. Fractional base units are refused. */
export async function offerFromSymbol(origin: string, symbol: string, pricePerMillion: string): Promise<WorkerOffer> {
  let response: Response;
  try { response = await fetch(new URL("/v1/market", origin), { redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw Error("The exchange market is unavailable"); }
  if (!response.ok) throw Error("The exchange market is unavailable");
  const market = await response.json() as { markets?: { asset: { id: string; symbol: string; decimals: number } }[] };
  const matches = (market.markets ?? []).filter(item => item.asset.symbol.toUpperCase() === symbol.toUpperCase());
  if (matches.length !== 1) throw Error("Unknown or ambiguous asset symbol for this exchange");
  const { id, decimals } = matches[0]!.asset;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw Error("Unsupported asset decimals");
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,36})?$/.test(pricePerMillion)) throw Error("Price must be a plain decimal number");
  const [whole, fraction = ""] = pricePerMillion.split(".");
  if (fraction.length > decimals) throw Error("Price has more decimal places than the asset supports");
  const perMillion = BigInt(whole! + fraction.padEnd(decimals, "0"));
  if (perMillion === 0n || perMillion % 1_000_000n !== 0n) {
    const step = 1_000_000n, unit = 10n ** BigInt(decimals);
    const human = decimals === 0 ? String(step) : (step / unit).toString() + (step % unit ? "." + (step % unit).toString().padStart(decimals, "0").replace(/0+$/, "") : "");
    throw Error(`Price per million tokens must be a positive multiple of ${human} ${matches[0]!.asset.symbol}`);
  }
  return parseWorkerOffer({ assetId: id, netUnits: String(perMillion / 1_000_000n) });
}
export async function writeWorkerOffer(stateDir: string, input: unknown): Promise<WorkerOffer> {
  const offer = parseWorkerOffer(input);
  await mkdir(resolve(stateDir), { recursive: true });
  await atomicPrivateJson(join(resolve(stateDir), "offer.json"), offer);
  return offer;
}
