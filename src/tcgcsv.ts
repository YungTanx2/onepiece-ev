import axios from 'axios';
import { PriceEntry, Rarity } from './types';

// One Piece Card Game category ID on TCGCSV (tcgcsv.com/tcgplayer/68/...).
const CATEGORY_ID = 68;

// All base rarity strings that appear in One Piece TCGCSV extendedData.Rarity.
const VALID_BASE_RARITIES = new Set<string>([
  'C', 'UC', 'R', 'SR', 'SEC', 'L', 'DON!!', 'TR', 'SP', 'PR',
]);

export interface ExtendedDataEntry {
  name: string;
  displayName: string;
  value: string;
}

export interface TCGProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string;
  extendedData?: ExtendedDataEntry[];
}

export interface TCGPrice {
  productId: number;
  subTypeName: string;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
}

/** Extract and validate the base rarity string from a product's extendedData. */
function extractBaseRarity(extendedData: ExtendedDataEntry[] = []): string | null {
  const entry = extendedData.find((e) => e.name === 'Rarity');
  if (!entry || !VALID_BASE_RARITIES.has(entry.value)) return null;
  return entry.value;
}

/**
 * Apply One Piece variant detection to a product name, returning the final
 * Rarity bucket. This is the canonical implementation of the 5-rule variant table.
 *
 * Rules (applied in order — first match wins):
 *   (Parallel) or (Alternate Art)  on L     → 'Alt Art Leader'
 *   (Parallel) or (Alternate Art)  on other → 'Alt Art'
 *   (Manga)                        on any   → 'Manga'
 *   (Wanted Poster)                on any   → 'SP'  (rarity promotion)
 *   (Gold)                         on DON!! → 'Gold DON!!'
 *   (Gold)                         on other → log warning, keep base rarity
 *   no suffix                               → base rarity unchanged
 */
function resolveRarity(baseRarity: string, productName: string): Rarity {
  const m = productName.match(/\((Parallel|Alternate Art|Manga|Wanted Poster|Gold)\)\s*$/i);
  if (!m) return baseRarity as Rarity;

  const label = m[1].toLowerCase();

  if (label === 'parallel' || label === 'alternate art') {
    return baseRarity === 'L' ? 'Alt Art Leader' : 'Alt Art';
  }
  if (label === 'manga') {
    return 'Manga';
  }
  if (label === 'wanted poster') {
    // Wanted Poster variants are a style of SP — promote regardless of base rarity.
    return 'SP';
  }
  if (label === 'gold') {
    if (baseRarity === 'DON!!') return 'Gold DON!!';
    console.warn(`[tcgcsv] Unexpected (Gold) variant on non-DON!! card: "${productName}" (base: ${baseRarity})`);
    return baseRarity as Rarity;
  }

  return baseRarity as Rarity;
}

const HEADERS = { 'User-Agent': 'onepiece-ev/1.0' };

/**
 * Fetch all products (cards + sealed products) for a One Piece set from TCGCSV.
 * @param groupId - TCGCSV group ID for the set (see sets.ts for the full list)
 */
export async function fetchProducts(groupId: number): Promise<TCGProduct[]> {
  console.log('  [tcgcsv] Fetching products…');
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGProduct[] }>(`${base}/products`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

/**
 * Fetch current market prices for all products in a One Piece set from TCGCSV.
 * Each product has either Normal or Foil pricing (never both for the same productId).
 * @param groupId - TCGCSV group ID for the set
 */
export async function fetchPrices(groupId: number): Promise<TCGPrice[]> {
  console.log('  [tcgcsv] Fetching prices…');
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGPrice[] }>(`${base}/prices`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

/**
 * Derives the One Piece card list from TCGCSV product data.
 * Products with a valid base Rarity in extendedData are individual cards;
 * sealed products (booster boxes, cases) have no Rarity and are skipped.
 */
export function extractCards(products: TCGProduct[]): { name: string; rarity: Rarity }[] {
  const cards: { name: string; rarity: Rarity }[] = [];
  for (const product of products) {
    const base = extractBaseRarity(product.extendedData);
    if (!base) continue;
    const rarity = resolveRarity(base, product.name);
    cards.push({ name: product.name, rarity });
  }
  return cards;
}

/**
 * Builds a pre-keyed price map from the raw prices array.
 * Key format: `${productId}::${subTypeName}`
 */
export function buildPriceMap(prices: TCGPrice[]): Map<string, TCGPrice> {
  const map = new Map<string, TCGPrice>();
  for (const p of prices) {
    map.set(`${p.productId}::${p.subTypeName}`, p);
  }
  return map;
}

/**
 * Builds PriceEntry[] by joining products (which carry rarity via extendedData)
 * with prices by productId.
 *
 * One Piece subType handling:
 * - Each productId is exclusively Normal OR Foil — never both.
 * - Foil = pack-pulled cards; Normal = Starter Deck reprints.
 * - Entries for BOTH subtypes are emitted so the spike scanner can track all cards.
 * - The calculator's EV math uses only Foil entries (see calculator.ts groupEntries logic).
 *
 * Variant detection is applied to every card — see resolveRarity() above.
 */
export function matchPrices(products: TCGProduct[], prices: TCGPrice[]): PriceEntry[] {
  const priceMap = buildPriceMap(prices);
  const entries: PriceEntry[] = [];

  for (const product of products) {
    const base = extractBaseRarity(product.extendedData);
    if (!base) continue; // skip sealed products (booster boxes, cases, etc.)

    const rarity = resolveRarity(base, product.name);
    const image  = product.imageUrl ?? undefined;

    // Try Foil first (pack-pull subType), then Normal (starter-deck reprint).
    // Emit whichever is present; spike scanner uses all, EV calc filters to Foil only.
    const foilPrice   = priceMap.get(`${product.productId}::Foil`);
    const normalPrice = priceMap.get(`${product.productId}::Normal`);

    if (foilPrice) {
      const marketPrice = foilPrice.marketPrice ?? 0;
      const midPrice    = foilPrice.midPrice    ?? 0;
      if (marketPrice > 0 || midPrice > 0) {
        entries.push({
          productId: product.productId,
          name: product.name,
          rarity,
          subType: 'Foil',
          marketPrice,
          midPrice,
          image,
        });
      }
    }

    if (normalPrice) {
      const marketPrice = normalPrice.marketPrice ?? 0;
      const midPrice    = normalPrice.midPrice    ?? 0;
      if (marketPrice > 0 || midPrice > 0) {
        entries.push({
          productId: product.productId,
          name: product.name,
          rarity,
          subType: 'Normal',
          marketPrice,
          midPrice,
          image,
        });
      }
    }
  }

  return entries;
}

/** Re-export extractBaseRarity for use in server.ts (booster box detection). */
export { extractBaseRarity as extractRarity };
