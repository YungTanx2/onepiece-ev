import { getPrice7DaysAgo } from './price-history-db';

/**
 * Returns the market price for a product+variant from 7 days ago,
 * sourced from the local SQLite price history database populated by
 * the TCGCSV daily archive ingest (archive-ingest.ts).
 *
 * Returns null if no historical data is available (DB not yet populated
 * for this product or the backfill hasn't run yet).
 */
export function getBaseline7DaysAgo(productId: number, subTypeName: string): number | null {
  return getPrice7DaysAgo(productId, subTypeName);
}
