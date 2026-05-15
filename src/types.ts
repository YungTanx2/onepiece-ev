// Base rarities that appear in One Piece TCG extendedData.Rarity on TCGCSV (category 68).
export type BaseRarity =
  | 'C'      // Common
  | 'UC'     // Uncommon
  | 'R'      // Rare
  | 'SR'     // Super Rare
  | 'SEC'    // Secret Rare
  | 'L'      // Leader
  | 'DON!!'  // DON!! card (Premium Boosters only)
  | 'TR'     // Treasure Rare (OP-13+ sets)
  | 'SP'     // Special — also absorbs (Wanted Poster) variant (rarity promotion)
  | 'PR';    // Promo Rare (Premium Boosters only)

// Variant-derived buckets created by product name suffix detection in tcgcsv.ts.
// These do NOT appear in extendedData.Rarity — they are synthetic.
//
// Detection rules (in order):
//   (Parallel) or (Alternate Art)  on L     → 'Alt Art Leader'
//   (Parallel) or (Alternate Art)  on other → 'Alt Art'
//   (Manga)                        on any   → 'Manga'
//   (Wanted Poster)                on any   → 'SP'  (rarity promotion, not its own bucket)
//   (SP)                           on any   → 'SP'  (Special print; base rarity kept in extendedData)
//   (Gold)                         on DON!! → 'Gold DON!!'
export type Rarity =
  | BaseRarity
  | 'Alt Art'        // (Parallel)/(Alternate Art) on non-Leader — flat 1-in-12 default rate
  | 'Alt Art Leader' // (Parallel)/(Alternate Art) on Leader    — flat 1-in-72 global rate
  | 'Manga'          // (Manga) on any card                     — flat 1-in-1000 global rate
  | 'Gold DON!!';    // (Gold) on DON!! cards                   — Premium-only chase pull

// TCGCSV subType names for One Piece cards.
// Each productId is exclusively one OR the other — never both for the same card.
// Pack-pulled cards are Foil; Normal prints come from Starter Decks.
export type SubType = 'Normal' | 'Foil';

export interface OnePieceCard {
  name: string;
  rarity: Rarity;
  image?: string;
}

export interface PriceEntry {
  productId: number;
  name: string;
  rarity?: Rarity;
  subType: SubType;
  marketPrice: number;
  midPrice: number;
  image?: string;
}

export interface RarityStats {
  rarity: string;
  /** Average Foil price for cards of this rarity (Foil = pack-pull subType). */
  avgFoilPrice: number | null;
  /** Number of Foil-priced cards counted in the average. */
  foilPriced: number;
  /** Total EV contribution of this rarity bucket to the box EV. */
  evContribution: number;
}

export interface SlotBreakdown {
  /** EV from the Common filler slot (Standard boxes only). */
  commonEv: number;
  /** EV from the Uncommon filler slot (Standard boxes only). */
  uncommonEv: number;
  /** EV from the guaranteed Rare slot (Standard boxes only). */
  rareEv: number;
  /** EV from the Leader slot (Standard boxes only). */
  leaderEv: number;
  /** EV from the hit slot — SR, SEC, SP, Alt Art, DON!!, etc. */
  hitEv: number;
}

export interface HitRarityBreakdown {
  /** P(rarity per pack) derived from pull-rates config (1/oneInXPacks). */
  fraction: number;
  /** Average Foil price for this rarity, or null if no priced cards found. */
  avgPrice: number | null;
  /** fraction × avgPrice × packsPerBox — expected $ contribution per box. */
  evPerBox: number;
}

export interface EvResult {
  evPerPack: number;
  evPerBox: number;
  boxCost: number;
  /** How the box price was determined. */
  boxPriceSource: 'box' | 'bundle' | 'manual' | 'unknown';
  profit: number;
  byRarity: Record<string, RarityStats>;
  /** Top hit-slot + leader cards by price (Foil subType, price >= $1). */
  topPulls: PriceEntry[];
  /** Top case-hit-tier cards (Manga, SP, SEC, etc. — very rare pulls). */
  topCaseHitPulls: PriceEntry[];
  slotBreakdown: SlotBreakdown;
  /** Per-rarity EV breakdown for the hit slot, keyed by rarity name. */
  hitBreakdown: Record<string, HitRarityBreakdown>;
  pricedCardCount: number;
  totalCardCount: number;
}

export interface Sale {
  condition: string;
  variant: string;
  quantity: number;
  purchasePrice: number;
  orderDate: string;
}

export interface ScanCardResult {
  productId: number;
  subType: string;
  name: string;
  rarity: string;
  currentMarketPrice: number;
  recentAvgPrice: number;
  recentSalesCount: number;
  dailyPctChange: number;
  dailyAbsChange: number;
  dailySpiking: boolean;
  weeklyPctChange: number | null;
  weeklyAbsChange: number | null;
  weeklySpiking: boolean;
  price7dAgo: number | null;
  error?: boolean;
}
