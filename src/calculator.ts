import { PriceEntry, Rarity, EvResult, RarityStats, SlotBreakdown, HitRarityBreakdown } from './types';
import { ResolvedPullRates } from './pull-rates-loader';

/**
 * Pull rates consumed by the calculator — resolved from the JSON layer by pull-rates-loader.ts.
 * All rates are per-pack decimal probabilities (hitDistribution values = 1/oneInXPacks).
 */
export type { ResolvedPullRates };

/**
 * Threshold for classifying a hit as a "case hit" (very rare pull).
 * Rarities with P(per pack) below this appear in topCaseHitPulls rather than topPulls.
 * 1/100 packs = 0.01 — roughly "less than 1 per 4 boxes".
 */
const CASE_HIT_THRESHOLD = 0.01;

/**
 * Per-card bulk threshold. Cards below $0.50 are realistically sold to bulk buyers
 * at ~$0.01/card rather than as singles. EV math uses this realizable value.
 */
const BULK_THRESHOLD = 0.50;
const BULK_RATE      = 0.01;

/** Realizable effective price: prefer marketPrice, fall back to midPrice, clamp bulk. */
function effectivePrice(entry: PriceEntry): number {
  const raw = entry.marketPrice > 0 ? entry.marketPrice : entry.midPrice;
  return raw >= BULK_THRESHOLD ? raw : BULK_RATE;
}

/** Average effective price over a list of entries. Returns null if empty. */
function avgPrice(entries: PriceEntry[]): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((sum, e) => sum + effectivePrice(e), 0) / entries.length;
}

/**
 * Groups PriceEntry[] by rarity × subType.
 * Key format: `${rarity}::${subType}`
 */
function groupEntries(entries: PriceEntry[]): Map<string, PriceEntry[]> {
  const map = new Map<string, PriceEntry[]>();
  for (const entry of entries) {
    const key = `${entry.rarity ?? 'Unknown'}::${entry.subType}`;
    const existing = map.get(key) ?? [];
    existing.push(entry);
    map.set(key, existing);
  }
  return map;
}

function getGroup(grouped: Map<string, PriceEntry[]>, rarity: string, subType: string): PriceEntry[] {
  return grouped.get(`${rarity}::${subType}`) ?? [];
}

// All One Piece rarity buckets — used to seed byRarity with zeroed stats.
// Includes base rarities + variant buckets so every possible bucket appears in the output.
const ALL_RARITIES: Rarity[] = [
  'C', 'UC', 'R', 'SR', 'SEC', 'L', 'DON!!', 'TR', 'SP', 'PR',
  'Alt Art', 'Alt Art Leader', 'Manga', 'Gold DON!!',
  'SP Gold', 'SP Silver', 'Super Alt Art',
];

// Rarities that always surface in topCaseHitPulls even without a configured pull rate.
// These are ultra-rare variants introduced after initial pull-rate research; pull rates
// are unknown so they contribute $0 to EV, but should still be visible in the UI.
const ALWAYS_CASE_HIT = new Set<string>(['SP Gold', 'SP Silver', 'Super Alt Art']);

/**
 * Calculate expected value (EV) for a One Piece booster box.
 *
 * Pack structure (Standard boxes — commonCount is defined):
 *   commonCount   × Common Foil  (avg over all Foil Common cards in set)
 *   uncommonCount × Uncommon Foil
 *   rareCount     × Rare Foil    (guaranteed Rare slot per pack)
 *   leaderPerPack × Leader Foil  (fractional; ~4 leaders per 24-pack box)
 *   hitDistribution entries      (SR, SEC, SP, Alt Art, Manga, Alt Art Leader, etc.)
 *
 * Pack structure (Premium boxes — commonCount is undefined):
 *   hitDistribution entries only (SR, SEC, PR, Alt Art, DON!!, Gold DON!!, etc.)
 *
 * EV math uses Foil subType prices only (Foil = pack-pull; Normal = Starter Deck reprints).
 *
 * @param entries   - Priced card entries from matchPrices()
 * @param pullRates - Resolved rates from loadPullRates()
 * @param boxCost   - Current retail price of the box in USD
 */
export function calculateEV(
  entries: PriceEntry[],
  pullRates: ResolvedPullRates,
  boxCost: number,
  excludeCaseHits = false,
): EvResult {
  const { packsPerBox, commonCount, uncommonCount, rareCount, leaderPerPack, hitDistribution, isStandard } = pullRates;

  // Group by rarity × subType; EV calc always uses 'Foil' group
  const grouped = groupEntries(entries);

  // ── Per-rarity stats (Foil subType only for EV) ───────────────────────────
  const byRarity: Record<string, RarityStats> = {};
  for (const rarity of ALL_RARITIES) {
    const foilGroup = getGroup(grouped, rarity, 'Foil');
    byRarity[rarity] = {
      rarity,
      avgFoilPrice: avgPrice(foilGroup),
      foilPriced: foilGroup.length,
      evContribution: 0,
    };
  }

  // ── Standard-only filler slots ────────────────────────────────────────────
  let commonEv   = 0;
  let uncommonEv = 0;
  let rareEv     = 0;
  let leaderEv   = 0;

  if (isStandard) {
    // Common slot: commonCount cards per pack, all drawn from Common Foil pool
    commonEv = (commonCount ?? 0) * (byRarity['C']?.avgFoilPrice ?? 0);
    if (byRarity['C']) byRarity['C'].evContribution += commonEv;

    // Uncommon slot
    uncommonEv = (uncommonCount ?? 0) * (byRarity['UC']?.avgFoilPrice ?? 0);
    if (byRarity['UC']) byRarity['UC'].evContribution += uncommonEv;

    // Guaranteed Rare slot
    rareEv = (rareCount ?? 1) * (byRarity['R']?.avgFoilPrice ?? 0);
    if (byRarity['R']) byRarity['R'].evContribution += rareEv;

    // Leader slot: fractional probability per pack (not one guaranteed per pack)
    if (leaderPerPack !== undefined) {
      leaderEv = leaderPerPack * (byRarity['L']?.avgFoilPrice ?? 0);
      if (byRarity['L']) byRarity['L'].evContribution += leaderEv;
    }
  }

  // ── Hit slot ──────────────────────────────────────────────────────────────
  // hitDistribution values are P(rarity per pack).
  // Covers SR, SEC, SP, Alt Art, Alt Art Leader, Manga, and Premium rarities.
  const caseHitRarities = new Set<string>(
    Object.entries(hitDistribution)
      .filter(([, fraction]) => fraction < CASE_HIT_THRESHOLD)
      .map(([rarity]) => rarity),
  );
  for (const r of ALWAYS_CASE_HIT) caseHitRarities.add(r);

  let hitEv = 0;
  const hitBreakdown: Record<string, HitRarityBreakdown> = {};

  for (const [rarity, fraction] of Object.entries(hitDistribution)) {
    // Ensure this rarity has a stats entry (handles variant buckets not in ALL_RARITIES)
    if (!byRarity[rarity]) {
      const foilGroup = getGroup(grouped, rarity, 'Foil');
      byRarity[rarity] = { rarity, avgFoilPrice: avgPrice(foilGroup), foilPriced: foilGroup.length, evContribution: 0 };
    }

    const price  = byRarity[rarity]?.avgFoilPrice ?? null;
    const isCaseHit = caseHitRarities.has(rarity);
    const ev     = fraction * (excludeCaseHits && isCaseHit ? 0 : (price ?? 0));
    hitEv += ev;
    if (byRarity[rarity]) byRarity[rarity].evContribution += ev;
    hitBreakdown[rarity] = { fraction, avgPrice: price, evPerBox: ev * packsPerBox };
  }

  const slotBreakdown: SlotBreakdown = { commonEv, uncommonEv, rareEv, leaderEv, hitEv };
  const evPerPack = commonEv + uncommonEv + rareEv + leaderEv + hitEv;
  const evPerBox  = evPerPack * packsPerBox;

  // ── Top pulls ─────────────────────────────────────────────────────────────
  // Foil-subType cards only (pack-pull prices). Split by case-hit threshold.
  const allHitRarities  = new Set<string>(Object.keys(hitDistribution));
  const leaderRarities  = new Set<string>(['L', 'Alt Art Leader']);

  // topPulls: hit-slot + Leader cards that are NOT case hits, priced >= $1
  const topPulls = entries
    .filter(e =>
      e.subType === 'Foil' &&
      (allHitRarities.has(e.rarity ?? '') || leaderRarities.has(e.rarity ?? '')) &&
      !caseHitRarities.has(e.rarity ?? '') &&
      effectivePrice(e) >= 1.0,
    )
    .sort((a, b) => effectivePrice(b) - effectivePrice(a))
    .slice(0, 20);

  // topCaseHitPulls: Manga, SP, SEC when they're case-hit-tier, priced >= $1
  const topCaseHitPulls = entries
    .filter(e =>
      e.subType === 'Foil' &&
      caseHitRarities.has(e.rarity ?? '') &&
      effectivePrice(e) >= 1.0,
    )
    .sort((a, b) => effectivePrice(b) - effectivePrice(a))
    .slice(0, 20);

  return {
    evPerPack,
    evPerBox,
    boxCost,
    boxPriceSource: 'unknown' as const, // overwritten by server.ts
    profit: evPerBox - boxCost,
    byRarity,
    topPulls,
    topCaseHitPulls,
    slotBreakdown,
    hitBreakdown,
    excludedCaseHits: excludeCaseHits,
    pricedCardCount: new Set(entries.filter(e => e.subType === 'Foil').map(e => e.productId)).size,
    totalCardCount: 0, // populated by server.ts after extractCards
  };
}
