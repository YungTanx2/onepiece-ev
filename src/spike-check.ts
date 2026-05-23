import { fetchSales } from './latestsales';
import { getBaseline7DaysAgo } from './pricehistory';
import { ScanCardResult } from './types';

const MIN_RECENT_UNITS   = 3;
const MIN_ABS_CHANGE     = 1.0;
const PCT_THRESHOLD      = 0.25;
const RECENT_SALES_COUNT = 10;
const MAX_SALE_AGE_DAYS  = 5;
const MAX_SALE_AGE_MS    = MAX_SALE_AGE_DAYS * 24 * 60 * 60 * 1000;

function isRecentEnough(sales: { orderDate: string }[]): boolean {
  let newest = 0;
  for (const s of sales) {
    const ts = new Date(s.orderDate).getTime();
    if (ts > newest) newest = ts;
  }
  return newest > 0 && newest >= Date.now() - MAX_SALE_AGE_MS;
}

/**
 * Fetch latestsales for one card and compute both daily and weekly spike metrics
 * in a single pass. Daily baseline = current TCGCSV market price. Weekly baseline
 * = 7-days-ago price from SQLite (null if backfill hasn't run yet for this card).
 *
 * Variant names from latestsales match TCGCSV subTypeNames directly ("Normal",
 * "Cold Foil", "Holofoil"), so no translation is needed.
 */
export async function scanCard(
  productId: number,
  subType: string,
  name: string,
  rarity: string,
  marketPrice: number,
): Promise<ScanCardResult> {
  const base: ScanCardResult = {
    productId, subType, name, rarity,
    currentMarketPrice: marketPrice,
    recentAvgPrice: 0, recentSalesCount: 0,
    dailyPctChange: 0, dailyAbsChange: 0, dailySpiking: false,
    weeklyPctChange: null, weeklyAbsChange: null, weeklySpiking: false,
    price7dAgo: null,
  };

  try {
    const sales = await fetchSales(productId);
    const nmSales = sales
      .filter(s => { const c = s.condition.toLowerCase(); return c.includes('near mint') || c === 'nm'; })
      .filter(s => s.variant === subType);

    if (!isRecentEnough(nmSales)) return base;

    const recent = nmSales.slice(0, RECENT_SALES_COUNT);
    const units  = recent.reduce((a, s) => a + s.quantity, 0);
    if (units < MIN_RECENT_UNITS) return base;

    const recentAvg = recent.reduce((a, s) => a + s.purchasePrice * s.quantity, 0) / units;

    // Daily: recent NM avg vs. current TCGCSV market price
    const dailyPct = (recentAvg - marketPrice) / marketPrice;
    const dailyAbs = recentAvg - marketPrice;

    // Weekly: recent NM avg vs. 7-days-ago price from SQLite
    const price7dAgo = getBaseline7DaysAgo(productId, subType);
    let weeklyPctChange: number | null = null;
    let weeklyAbsChange: number | null = null;
    let weeklySpiking = false;
    if (price7dAgo !== null && price7dAgo > 0) {
      weeklyPctChange = (recentAvg - price7dAgo) / price7dAgo;
      weeklyAbsChange = recentAvg - price7dAgo;
      weeklySpiking   = weeklyPctChange >= PCT_THRESHOLD && weeklyAbsChange >= MIN_ABS_CHANGE;
    }

    return {
      productId, subType, name, rarity,
      currentMarketPrice: marketPrice,
      recentAvgPrice: recentAvg,
      recentSalesCount: recent.length,
      dailyPctChange: dailyPct,
      dailyAbsChange: dailyAbs,
      dailySpiking: dailyPct >= PCT_THRESHOLD && dailyAbs >= MIN_ABS_CHANGE,
      weeklyPctChange, weeklyAbsChange, weeklySpiking,
      price7dAgo,
    };
  } catch {
    return { ...base, error: true };
  }
}
