import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Seven from 'node-7z';
import sevenBin from '7zip-bin';
import { initDb, upsertPrices, hasDateInDb, pruneOldRows } from './price-history-db';
import { TCGPrice } from './tcgcsv';

// Only ingest One Piece prices (category 68).
const TARGET_CATEGORY_IDS = new Set(['68']);

// On Linux (Railway, Render, etc.) npm doesn't always set the execute bit on
// bundled binaries. Ensure 7za is executable before the first extraction call.
try { fs.chmodSync(sevenBin.path7za, 0o755); } catch { /* Windows or already set */ }

// Regex matches extracted paths like: 2025-04-07/3/23821/prices
const PRICES_PATH_RE = /^(\d{4}-\d{2}-\d{2})\/(\d+)\/(\d+)\/prices$/;

/**
 * Download, extract, and ingest the TCGCSV daily price archive for a given date.
 * Idempotent — re-ingesting the same date overwrites existing rows (INSERT OR REPLACE).
 */
export async function ingestDate(dateStr: string): Promise<void> {
  const url = `https://tcgcsv.com/archive/tcgplayer/prices-${dateStr}.ppmd.7z`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgcsv-'));
  const archivePath = path.join(tmpDir, 'archive.7z');
  const extractDir  = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir);

  try {
    // 1. Download archive
    console.log(`[archive-ingest] Downloading ${url}`);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    fs.writeFileSync(archivePath, Buffer.from(response.data));

    // 2. Extract full directory structure to extractDir
    await new Promise<void>((resolve, reject) => {
      const stream = Seven.extractFull(archivePath, extractDir, { $bin: sevenBin.path7za });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    // 3. Walk extracted files, filter to Pokemon (category 3), parse + ingest
    let filesIngested = 0;
    walkDir(extractDir, (filePath) => {
      const relative = filePath.replace(extractDir, '').replace(/\\/g, '/').replace(/^\//, '');
      const match = PRICES_PATH_RE.exec(relative);
      if (!match) return;

      const [, date, categoryId] = match;
      if (!TARGET_CATEGORY_IDS.has(categoryId)) return;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        const prices: TCGPrice[] = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
        if (prices.length > 0) {
          upsertPrices(date, prices);
          filesIngested++;
        }
      } catch {
        // Skip malformed files silently
      }
    });

    pruneOldRows(30);
    console.log(`[archive-ingest] Ingested ${dateStr}: ${filesIngested} One Piece sets`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Ingest today's archive. No-op if today's data is already in the DB.
 */
export async function ingestToday(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (hasDateInDb(today)) {
    console.log(`[archive-ingest] Today (${today}) already ingested, skipping`);
    return;
  }
  await ingestDate(today);
}

/**
 * Download any missing dates from the past `days` days.
 * Runs sequentially to avoid hammering TCGCSV on first deployment.
 * Skips dates already present in the DB.
 */
export async function backfillMissingDays(days: number = 10): Promise<void> {
  initDb();
  for (let i = days; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    if (hasDateInDb(date)) continue;
    try {
      await ingestDate(date);
    } catch (err: any) {
      console.warn(`[archive-ingest] Skipped ${date}: ${err.message}`);
    }
  }
}

/** Recursively walk a directory, calling cb for each file. */
function walkDir(dir: string, cb: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walkDir(full, cb);
    else cb(full);
  }
}
