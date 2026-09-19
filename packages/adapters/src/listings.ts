import { MODEL_CATALOG, MEDIA_CATALOG, type ModelEntry } from "./manifest.js";
import { HOSTED_CATALOG, type HostedModelEntry } from "./hosted-catalog.js";
import { HOSTED_MEDIA_CATALOG, type MediaListing } from "./hosted-media-catalog.js";

/** One market per model (owner decision, 19 September 2026). A listing is what a buyer chooses: one model, sold by every
 * supplier who serves it. Its variants are the approved ways to run it: the pinned supplier build (GGUF and a local runtime)
 * and, where a hosted provider serves the same model, EXCESS house supply. Offers for any variant compete on price in the
 * listing's one market; a quote binds the variant of the offer it chose, and the receipt names that capability. */
export type ListingVariant = ModelEntry | HostedModelEntry | MediaListing;
export interface Listing {
  /** The supplier catalog id, or the house id for a model only EXCESS supplies. */
  readonly id: string;
  readonly kind: "text" | "embedding" | "transcription" | "image";
  /** The supplier build first when there is one; it describes the listing (size, format, memory). */
  readonly variants: readonly ListingVariant[];
  /** Other ids accepted for this listing: the house ids of merged house variants, which were listings of their own before. */
  readonly aliases: readonly string[];
}
const kindOf = (entry: ListingVariant): Listing["kind"] => "kind" in entry ? entry.kind : "text";
const isHouse = (entry: ListingVariant): boolean => "hosting" in entry && entry.hosting === "house";
const marketOf = (entry: ListingVariant): string | undefined => "market" in entry && typeof entry.market === "string" ? entry.market : undefined;

/** The request terms a variant accepts: output bounds for text; unit and limits for media. */
function terms(entry: ListingVariant): unknown {
  const capability = entry.capability as Record<string, unknown>;
  return "kind" in entry ? { meteringUnit: capability.meteringUnit, limits: capability.limits }
    : { maxOutputTokens: capability.maxOutputTokens, minOutputTokens: capability.minOutputTokens ?? 1 };
}
function build(): readonly Listing[] {
  const listings: { id: string; kind: Listing["kind"]; variants: ListingVariant[]; aliases: string[] }[] = [];
  const byId = new Map<string, (typeof listings)[number]>();
  const add = (entry: ListingVariant) => {
    const target = marketOf(entry);
    if (target === undefined) {
      if (byId.has(entry.id)) throw Error("Duplicate listing " + entry.id);
      const listing = { id: entry.id, kind: kindOf(entry), variants: [entry], aliases: [] };
      listings.push(listing); byId.set(entry.id, listing);
      return;
    }
    const listing = byId.get(target);
    // A house model joins only a supplier listing of the same kind, and only one house variant per listing.
    if (!listing || isHouse(listing.variants[0]!) || listing.kind !== kindOf(entry) || listing.variants.some(isHouse))
      throw Error("Invalid market for " + entry.id);
    // Buyers ask once for any variant, so every variant takes exactly the same requests and bills the same unit.
    if (JSON.stringify(terms(listing.variants[0]!)) !== JSON.stringify(terms(entry))) throw Error("Market terms differ for " + entry.id);
    listing.variants.push(entry); listing.aliases.push(entry.id);
  };
  // Supplier text, house-only text, supplier media, house-only media: the order the market lists them in.
  for (const entry of MODEL_CATALOG) add(entry);
  for (const entry of HOSTED_CATALOG) if (marketOf(entry) === undefined) add(entry);
  for (const entry of MEDIA_CATALOG) add(entry);
  for (const entry of HOSTED_MEDIA_CATALOG) if (marketOf(entry) === undefined) add(entry);
  for (const entry of [...HOSTED_CATALOG, ...HOSTED_MEDIA_CATALOG]) if (marketOf(entry) !== undefined) add(entry);
  return Object.freeze(listings.map(listing => Object.freeze({ ...listing, variants: Object.freeze(listing.variants), aliases: Object.freeze(listing.aliases) })));
}
export const LISTINGS: readonly Listing[] = build();

/** The listing an id names: a listing id or one of its aliases. */
export function listingById(id: string): Listing | undefined {
  return LISTINGS.find(listing => listing.id === id || listing.aliases.includes(id));
}
/** The listing a capability digest belongs to. */
export function listingByDigest(digest: string): Listing | undefined {
  return LISTINGS.find(listing => listing.variants.some(variant => variant.capabilityDigest === digest));
}
/** The market id every catalog capability belongs to, for the database's capability_markets rows. */
export function capabilityMarkets(): { digest: string; marketId: string }[] {
  return LISTINGS.flatMap(listing => listing.variants.map(variant => ({ digest: variant.capabilityDigest, marketId: listing.id })));
}
