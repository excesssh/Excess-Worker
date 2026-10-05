import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DEFAULT_MODEL_ID, MEDIA_CATALOG, MODEL_CATALOG } from "@excess/adapters";
import { PRICE_DECIMALS, positivePriceSchema, formatPrice, priceMicros } from "@excess/protocol";
import { atomicPrivateJson, readPrivateText, type StateWriteContext } from "./control.js";

/** The supplier's public ask for one catalog model: net base units per metering unit (output token, input token,
 * audio second or image) in one asset, a price with up to six fractional digits (below one base unit is allowed). */
export type WorkerOffer = { assetId: string; netUnits: string; minNetUnits?: string; maxNetUnits?: string; auto?: "follow_lowest" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validPrice = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && positivePriceSchema.safeParse(value).success;
export function parseWorkerOffer(input: unknown): WorkerOffer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid worker offer");
  const value = input as Record<string, unknown>;
  const banded=value.minNetUnits!==undefined||value.maxNetUnits!==undefined;
  if (Object.keys(value).length !== (banded?4:2)+(value.auto===undefined?0:1) || typeof value.assetId !== "string" || !uuid.test(value.assetId) ||
      !validPrice(value.netUnits) || (banded && (!validPrice(value.minNetUnits)||!validPrice(value.maxNetUnits)))) throw Error("Invalid worker offer");
  if(value.auto!==undefined&&(value.auto!=="follow_lowest"||!banded))throw Error("Automatic pricing requires a price band");
  if(banded&&(priceMicros(value.minNetUnits as string)>priceMicros(value.netUnits)||
      priceMicros(value.netUnits)>priceMicros(value.maxNetUnits as string))) throw Error("Invalid worker offer: price is outside its bounds");
  return { assetId: value.assetId, netUnits: value.netUnits, ...(banded?{minNetUnits:value.minNetUnits as string,maxNetUnits:value.maxNetUnits as string}:{}),
    ...(value.auto?{auto:"follow_lowest" as const}:{}) };
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
function autoStatePath(stateDir:string,modelId:string){offerPath(stateDir,modelId);return join(resolve(stateDir),"offers",modelId+".auto.json");}
/** Last automatic ask, saved before publication so a restart cannot mistake its own live ask for a competitor. */
export async function readWorkerAutoPrices(stateDir:string,modelId:string):Promise<Map<string,string>> {
  let raw:string;
  try {raw=await readPrivateText(autoStatePath(stateDir,modelId),4096);}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return new Map();throw error;}
  const value=JSON.parse(raw) as unknown;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==1||!("prices" in value)||
      !value.prices||typeof value.prices!=="object"||Array.isArray(value.prices))throw Error("Invalid automatic price state");
  const entries=Object.entries(value.prices);
  if(entries.length>MAX_WORKER_OFFERS||entries.some(([asset,price])=>!uuid.test(asset)||!validPrice(price)))throw Error("Invalid automatic price state");
  return new Map(entries as [string,string][]);
}
export async function saveWorkerAutoPrices(stateDir:string,modelId:string,prices:ReadonlyMap<string,string>,writes?:StateWriteContext):Promise<void> {
  const entries=[...prices];
  if(entries.length>MAX_WORKER_OFFERS||entries.some(([asset,price])=>!uuid.test(asset)||!validPrice(price)))throw Error("Invalid automatic price state");
  await atomicPrivateJson(autoStatePath(stateDir,modelId),{prices:Object.fromEntries(entries)},writes);
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
  const existing=await readWorkerOffers(stateDir,modelId),previous=existing.find(item=>item.assetId===offer.assetId);
  const updated=parseWorkerOffer({...offer,...(previous?.minNetUnits!==undefined&&offer.minNetUnits===undefined?
    {minNetUnits:previous.minNetUnits,maxNetUnits:previous.maxNetUnits,...(previous.auto?{auto:previous.auto}:{})}:{})});
  const offers = [...existing.filter(item => item.assetId !== offer.assetId), updated];
  if (offers.length > MAX_WORKER_OFFERS) throw Error(`A model can be priced in at most ${MAX_WORKER_OFFERS} assets`);
  await mkdir(join(resolve(stateDir), "offers"), { recursive: true });
  await atomicPrivateJson(path, { offers });
  return offers;
}
/** A supplier's local guardrail: later CLI price edits must stay in this exact unit-price interval. */
export async function setWorkerPriceBand(stateDir:string,assetId:string,minNetUnits:string,maxNetUnits:string,modelId:string=DEFAULT_MODEL_ID):Promise<WorkerOffer[]> {
  if(!uuid.test(assetId)) throw Error("Invalid asset");
  const path=offerPath(stateDir,modelId),existing=await readWorkerOffers(stateDir,modelId);
  if(!existing.some(item=>item.assetId===assetId)) throw Error("Set an offer price before its bounds");
  const offers=existing.map(item=>item.assetId===assetId?parseWorkerOffer({...item,minNetUnits,maxNetUnits}):item);
  await atomicPrivateJson(path,{offers});
  return offers;
}
export async function clearWorkerPriceBand(stateDir:string,assetId:string,modelId:string=DEFAULT_MODEL_ID):Promise<WorkerOffer[]> {
  if(!uuid.test(assetId)) throw Error("Invalid asset");
  const path=offerPath(stateDir,modelId),existing=await readWorkerOffers(stateDir,modelId);
  if(!existing.some(item=>item.assetId===assetId)) throw Error("Offer price is not set");
  const offers=existing.map(item=>item.assetId===assetId?{assetId:item.assetId,netUnits:item.netUnits}:item);
  await atomicPrivateJson(path,{offers});
  return offers;
}
/** Automatic repricing is opt-in and cannot be enabled without the supplier's saved floor and ceiling. */
export async function setWorkerAutoPrice(stateDir:string,assetId:string,enabled:boolean,modelId:string=DEFAULT_MODEL_ID):Promise<WorkerOffer[]> {
  if(!uuid.test(assetId))throw Error("Invalid asset");
  const path=offerPath(stateDir,modelId),existing=await readWorkerOffers(stateDir,modelId),current=existing.find(item=>item.assetId===assetId);
  if(!current)throw Error("Offer price is not set");
  if(enabled&&current.minNetUnits===undefined)throw Error("Set a price band before automatic pricing");
  const offers=existing.map(item=>{
    if(item.assetId!==assetId)return item;
    const {auto:_removed,...plain}=item;
    return parseWorkerOffer(enabled?{...plain,auto:"follow_lowest"}:plain);
  });
  await atomicPrivateJson(path,{offers});return offers;
}
/** Follow only a cheaper public ask, one micro base unit below it where the floor allows. Never raise a saved price. */
export function followedPrice(offer:WorkerOffer,cheapest:unknown):string {
  if(offer.auto!=="follow_lowest"||!validPrice(cheapest)||offer.minNetUnits===undefined||offer.maxNetUnits===undefined)return offer.netUnits;
  const current=priceMicros(offer.netUnits),market=priceMicros(cheapest),floor=priceMicros(offer.minNetUnits),ceiling=priceMicros(offer.maxNetUnits);
  if(market>=current)return offer.netUnits;
  const next=market>floor?market-1n:floor;
  return formatPrice(next<floor?floor:next>ceiling?ceiling:next);
}
/** One bounded anonymous market read per publication. Bad or absent data leaves the supplier's saved prices untouched. */
export async function automaticWorkerPrices(origin:string,modelId:string,offers:WorkerOffer[],previous:ReadonlyMap<string,string>=new Map(),
  signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<WorkerOffer[]> {
  if(!offers.some(item=>item.auto))return offers;
  try {
    const response=await fetcher(new URL("/v1/market",origin),{redirect:"error",signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(5000)])});
    if(!response.ok){await response.body?.cancel();return offers;}
    const reader=response.body?.getReader();if(!reader)return offers;
    const chunks:Uint8Array[]= [];let size=0;
    for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2_097_152){await reader.cancel();return offers;}chunks.push(part.value);}
    const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as {models?:unknown};
    if(!Array.isArray(payload.models))return offers;
    const listing=payload.models.find(item=>item&&typeof item==="object"&&(item as {id?:unknown}).id===modelId) as {markets?:unknown}|undefined;
    const markets=listing?.markets;
    if(!Array.isArray(markets))return offers;
    return offers.map(offer=>{
      const market=markets.find(item=>item&&typeof item==="object"&&(item as {asset?:{id?:unknown}}).asset?.id===offer.assetId) as
        {status?:unknown;cheapestUnitNet?:unknown}|undefined;
      const last=previous.get(offer.assetId);
      const base=last&&validPrice(last)&&priceMicros(last)<priceMicros(offer.netUnits)?{...offer,netUnits:last}:offer;
      return market?.status==="available"?{...offer,netUnits:followedPrice(base,market.cheapestUnitNet)}:offer;
    });
  } catch { return offers; }
}
/** Withdraws the model's price in one asset; the worker stops renewing that offer and it lapses. Returns the prices left. */
export async function removeWorkerOffer(stateDir: string, assetId: string, modelId: string = DEFAULT_MODEL_ID): Promise<WorkerOffer[]> {
  if (!uuid.test(assetId)) throw Error("Invalid asset");
  const path = offerPath(stateDir, modelId), offers = (await readWorkerOffers(stateDir, modelId)).filter(item => item.assetId !== assetId);
  if (offers.length) await atomicPrivateJson(path, { offers });
  else await rm(path, { force: true });
  return offers;
}
