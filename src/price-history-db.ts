import Database from 'better-sqlite3';
import path from 'path';
import { TCGPrice } from './tcgcsv';

// On Railway, set DB_PATH to a persistent volume path (e.g. /data/price-history.db).
// Falls back to alongside dist/ for local development.
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '../price-history.db');

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');  // concurrent reads while writing
  }
  return _db;
}

/**
 * Create the price_history table and index if they don't exist.
 * Call once on startup before any reads/writes.
 */
export function initDb(): void {
  db().exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      date        TEXT    NOT NULL,
      productId   INTEGER NOT NULL,
      subTypeName TEXT    NOT NULL,
      marketPrice REAL,
      PRIMARY KEY (date, productId, subTypeName)
    );
    CREATE INDEX IF NOT EXISTS idx_ph_lookup
      ON price_history(productId, subTypeName, date DESC);
  `);
}

/**
 * Upsert a batch of prices for a given archive date.
 * Uses INSERT OR REPLACE so re-ingesting the same date is idempotent.
 */
export function upsertPrices(date: string, prices: TCGPrice[]): void {
  const stmt = db().prepare(`
    INSERT OR REPLACE INTO price_history (date, productId, subTypeName, marketPrice)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db().transaction((rows: TCGPrice[]) => {
    for (const p of rows) {
      stmt.run(date, p.productId, p.subTypeName, p.marketPrice ?? null);
    }
  });
  insertMany(prices);
}

/**
 * Returns the market price for a product+variant at the most recent date
 * at or before (today - 7 days). Returns null if no data is available.
 *
 * Uses ≤ comparison so if the exact day-7 archive is missing (e.g. TCGCSV
 * was down that day), we fall back to the nearest earlier date.
 */
export function getPrice7DaysAgo(productId: number, subTypeName: string): number | null {
  const targetDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const row = db().prepare(`
    SELECT marketPrice FROM price_history
    WHERE productId = ? AND subTypeName = ? AND date <= ?
    ORDER BY date DESC
    LIMIT 1
  `).get(productId, subTypeName, targetDate) as { marketPrice: number | null } | undefined;
  return row?.marketPrice ?? null;
}

/**
 * Returns true if the DB already has at least one row for the given date.
 * Used by backfill to skip dates that are already ingested.
 */
export function hasDateInDb(date: string): boolean {
  const row = db().prepare(
    'SELECT 1 FROM price_history WHERE date = ? LIMIT 1'
  ).get(date);
  return row !== undefined;
}

/**
 * Delete all rows older than keepDays days.
 * Called at the end of each ingest to keep the DB size bounded.
 */
export function pruneOldRows(keepDays: number = 30): void {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  db().prepare('DELETE FROM price_history WHERE date < ?').run(cutoff);
}
