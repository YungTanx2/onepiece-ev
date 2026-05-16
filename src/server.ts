import express from 'express';
import path from 'path';
import cron from 'node-cron';
import { fetchProducts, fetchPrices, extractCards, matchPrices, ExtendedDataEntry } from './tcgcsv';
import { calculateEV } from './calculator';
import { SUPPORTED_SETS, DEFAULT_SET_ID } from './sets';
import { loadPullRates } from './pull-rates-loader';
import { scanCard } from './spike-check';
import { ScanCardResult } from './types';
import { initDb } from './price-history-db';
import { backfillMissingDays, ingestToday } from './archive-ingest';

const app = express();
const PORT = process.env.PORT ?? 3006;

const scanCache = new Map<string, { result: ScanCardResult; timestamp: number }>();
const SCAN_CACHE_TTL = 30 * 60 * 1000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Init SQLite and start backfill on startup (non-blocking)
initDb();
backfillMissingDays(10).catch(err => console.error('[startup] backfill failed:', err));
cron.schedule('0 21 * * *', () => ingestToday().catch(console.error));

// Serve static files from public/ (one level above src/)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/sets', (_req, res) => {
  res.json(SUPPORTED_SETS);
});

app.get('/api/pull-rates', (req, res) => {
  const setId = (req.query.set as string | undefined)?.trim() ?? DEFAULT_SET_ID;
  try {
    const resolved = loadPullRates(setId);
    res.json(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

app.get('/api/analyze', async (req, res) => {
  // ── SSE headers ─────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(obj: object): void {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // ── Query params ─────────────────────────────────────────────────────────
  const boxPriceParam    = (req.query.boxPrice as string | undefined)?.trim();
  const setId            = (req.query.set as string | undefined)?.trim() ?? DEFAULT_SET_ID;
  const excludeCaseHits  = req.query.excludeCaseHits === 'true';

  const setDef = SUPPORTED_SETS.find((s) => s.id === setId);
  if (!setDef) {
    send({ type: 'error', message: `Unknown set ID: "${setId}". Valid IDs: ${SUPPORTED_SETS.map((s) => s.id).join(', ')}` });
    res.end();
    return;
  }

  // ── Load pull rates (global → default → per-set merge) ───────────────────
  let pullRates: ReturnType<typeof loadPullRates>;
  const customRatesParam = req.query.customRates as string | undefined;
  if (customRatesParam) {
    // Custom rates from the pull-rates modal (user-edited in UI).
    // The modal sends a pre-resolved JSON object, so we parse and trust it directly.
    try {
      pullRates = JSON.parse(customRatesParam);
    } catch {
      send({ type: 'error', message: 'Invalid customRates JSON in query parameter.' });
      res.end();
      return;
    }
  } else {
    try {
      pullRates = loadPullRates(setId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: 'error', message: `Could not load pull-rate config for set "${setId}": ${message}` });
      res.end();
      return;
    }
  }

  try {
    // ── Step 1: Fetch products + prices (parallel) ─────────────────────────
    send({ type: 'progress', step: 1, status: 'running', message: 'Fetching products and prices from TCGCSV…' });
    const [products, prices] = await Promise.all([fetchProducts(setDef.groupId), fetchPrices(setDef.groupId)]);
    send({ type: 'progress', step: 1, status: 'done', message: `Got ${products.length} products, ${prices.length} price entries` });

    // ── Step 2: Extract card list ──────────────────────────────────────────
    send({ type: 'progress', step: 2, status: 'running', message: 'Extracting card list from product data…' });
    const cards = extractCards(products);

    if (cards.length === 0) {
      send({ type: 'error', message: 'No cards with rarity data found in TCGCSV products.' });
      res.end();
      return;
    }

    send({ type: 'progress', step: 2, status: 'done', message: `Found ${cards.length} ${setDef.name} cards` });

    // ── Step 3: Resolve box price ──────────────────────────────────────────
    send({ type: 'progress', step: 3, status: 'running', message: 'Resolving booster box price…' });
    let boxCost: number;
    let boxPriceSource: 'box' | 'bundle' | 'manual' | 'unknown';

    if (boxPriceParam !== undefined && boxPriceParam !== '') {
      boxCost = parseFloat(boxPriceParam);
      if (isNaN(boxCost) || boxCost < 0) {
        send({ type: 'error', message: `Invalid box price value: "${boxPriceParam}"` });
        res.end();
        return;
      }
      boxPriceSource = 'manual';
      send({ type: 'progress', step: 3, status: 'done', message: `Using manual box price: $${boxCost.toFixed(2)}` });
    } else {
      // Look up the booster box product by name heuristic.
      // One Piece boxes are named "{Set Name} Booster Box" (TCGCSV convention).
      // Exclude cases and booster box cases (some sets have "Booster Box Case").
      const boxProduct = products.find((p) => {
        const n = p.name.toLowerCase();
        return !extractRarity(p.extendedData)
          && n.includes('booster box')
          && !n.includes('case')
          && !n.includes('half')
          && !n.includes('display');
      });

      // One Piece booster boxes appear as 'Normal' subType in TCGCSV prices
      const boxEntry = boxProduct
        ? prices.find((pr) => pr.productId === boxProduct.productId && pr.subTypeName === 'Normal')
        : undefined;
      const fetched = boxEntry ? (boxEntry.marketPrice ?? boxEntry.midPrice ?? null) : null;

      if (fetched !== null) {
        boxCost = fetched;
        boxPriceSource = 'box';
        send({ type: 'progress', step: 3, status: 'done', message: `Box market price: $${boxCost.toFixed(2)}` });
      } else {
        boxCost = 0;
        boxPriceSource = 'unknown';
        send({ type: 'progress', step: 3, status: 'done', message: 'Could not find box price in TCGCSV — using $0' });
      }
    }

    // ── Step 4: Match prices + calculate EV ───────────────────────────────
    send({ type: 'progress', step: 4, status: 'running', message: 'Matching prices and calculating EV…' });
    const entries = matchPrices(products, prices);
    const foilPricedCount = new Set(entries.filter(e => e.subType === 'Foil').map(e => e.productId)).size;

    const result = calculateEV(entries, pullRates, boxCost, excludeCaseHits);
    result.totalCardCount  = cards.length;
    result.pricedCardCount = foilPricedCount;
    result.boxPriceSource  = boxPriceSource;

    send({ type: 'progress', step: 4, status: 'done', message: `Matched prices for ${cards.length} cards (${foilPricedCount} Foil price entries)` });

    // ── Send final result ──────────────────────────────────────────────────
    send({ type: 'result', data: result, packsPerBox: pullRates.packsPerBox });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[server] Error during analysis:', message);
    send({ type: 'error', message });
  } finally {
    res.end();
  }
});

app.get('/api/scan-set', async (req, res) => {
  const setId = (req.query.set as string)?.trim() ?? DEFAULT_SET_ID;
  const setDef = SUPPORTED_SETS.find(s => s.id === setId);
  if (!setDef) { res.status(400).json({ error: `Unknown set: ${setId}` }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const [products, prices] = await Promise.all([
      fetchProducts(setDef.groupId), fetchPrices(setDef.groupId),
    ]);
    const entries = matchPrices(products, prices);

    // Scan all cards (both Foil and Normal) with market price >= $1.
    // The spike scanner is subType-agnostic — it tracks price history regardless of
    // whether the card is a pack-pull (Foil) or Starter Deck reprint (Normal).
    const MIN_PRICE = 1.0;
    const eligible = entries.filter(e => {
      const price = e.marketPrice > 0 ? e.marketPrice : e.midPrice;
      return price >= MIN_PRICE;
    });

    const now = Date.now();
    send('start', { totalCards: eligible.length });

    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 200;

    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const batch = eligible.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (entry, batchIdx) => {
        const marketPrice = entry.marketPrice > 0 ? entry.marketPrice : entry.midPrice;
        const key = `${entry.productId}:${entry.subType}`;
        const cached = scanCache.get(key);
        let result: ScanCardResult;
        if (cached && now - cached.timestamp < SCAN_CACHE_TTL) {
          result = cached.result;
        } else {
          result = await scanCard(
            entry.productId, entry.subType, entry.name,
            entry.rarity ?? 'Unknown', marketPrice,
          );
          scanCache.set(key, { result, timestamp: now });
        }
        send('card-result', result);
        send('progress', { completed: i + batchIdx + 1, total: eligible.length, cardName: entry.name });
      }));
      if (i + BATCH_SIZE < eligible.length) await delay(BATCH_DELAY_MS);
    }

    send('done', { total: eligible.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { message });
  } finally {
    res.end();
  }
});

/** Local helper to detect sealed products (no Rarity extendedData entry). */
function extractRarity(extendedData: ExtendedDataEntry[] = []): string | null {
  const VALID_RARITIES = new Set([
    'C', 'UC', 'R', 'SR', 'SEC', 'L', 'DON!!', 'TR', 'SP', 'PR',
  ]);
  const entry = extendedData.find((e) => e.name === 'Rarity');
  if (!entry || !VALID_RARITIES.has(entry.value)) return null;
  return entry.value;
}

app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  One Piece EV Calculator running at http://localhost:${PORT}`);
  console.log(`══════════════════════════════════════════════════════════\n`);
});
