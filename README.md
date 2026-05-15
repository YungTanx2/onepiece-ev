# One Piece TCG EV Calculator

Live booster box expected value calculator + price spike scanner for the **One Piece Card Game** (English). Streams real-time analysis from TCGPlayer prices via [TCGCSV](https://tcgcsv.com).

Supports **14 sets**: OP-07 through OP-16, EB-01/02/03, and Premium Booster -The Best- Vol. 2.

## Running locally

```bash
npm install
npm run dev          # ts-node — http://localhost:3006
npm run build        # compile to dist/
npm start            # run compiled build
```

Requires Node.js ≥ 18.

## How EV is calculated

### Pack structure

**Standard booster boxes** (OP-XX main sets, EB sets) — 24 packs/box, 5 slots per pack:

| Slot | Count | Pool |
|------|:-----:|------|
| Common | 7 | C (Foil) |
| Uncommon | 3 | UC (Foil) |
| Rare | 1 | R (Foil, guaranteed) |
| Leader | ~1 per 6 packs | L (Foil) |
| Hit | varies | SR, SEC, SP, Alt Art, Manga, TR, and variant buckets |

**Premium Booster** — 24 packs/box, every pack is a hit (no C/UC/R/Leader filler).

### Rarity buckets (14 total)

**Base rarities:** `C` `UC` `R` `SR` `SEC` `L` `DON!!` `TR` `SP` `PR`

**Variant buckets:** `Alt Art` `Alt Art Leader` `Manga` `Gold DON!!`

Variant detection rules (applied to the product name suffix):
- `(Parallel)` or `(Alternate Art)` on a Leader → `Alt Art Leader`
- `(Parallel)` or `(Alternate Art)` on anything else → `Alt Art`
- `(Manga)` → `Manga`
- `(Wanted Poster)` → promoted to `SP`
- `(Gold)` on a DON!! card → `Gold DON!!`

### Price filter

EV calculation uses **Foil subType prices only** — Normal products are Starter Deck reprints and are excluded from the calculator (but included in the spike scanner).

### Pull rate config

Rates live in three layers that deep-merge at runtime:

| File | Purpose |
|------|---------|
| `config/pull-rates.global.json` | Flat rates that apply to every product (Manga, SP, Alt Art Leader) |
| `config/pull-rates.default.json` | Standard booster baseline (24 packs, 7C+3UC+1R+1/6 L, SR/SEC/Alt Art rates) |
| `config/pull-rates-{set-id}.json` | Per-set overrides; Premium sets are fully self-contained and skip default |

Rates are stored as `{ "oneInXPacks": N }` integers (human-readable inverse probability). The loader converts to per-pack decimals at startup.

## Price spike scanner

After each EV analysis, a background scan streams through all cards in the set priced ≥ $1 and checks for:

- **Daily spike** — recent NM sales average ≥ 25% above TCGPlayer market price AND ≥ $1 higher
- **Weekly spike** — same threshold compared to 7-day-ago price from the SQLite price history

Price history is maintained by a daily 7z archive ingest from TCGCSV (runs at 21:00 UTC via cron), with a 10-day backfill on first boot. History is pruned to 30 days.

## Deployment (Railway)

```toml
# railway.toml — volume mounted at /data, DB_PATH=/data/price-history.db
```

```
# Procfile
web: node dist/server.js
```

Set environment variable `DB_PATH=/data/price-history.db` on the Railway service. `PORT` is injected automatically.

## Architecture

```
src/
  server.ts             Express — SSE endpoints /api/analyze, /api/scan-set, /api/sets, /api/pull-rates
  sets.ts               Set registry (14 sets, groupIds, default set)
  types.ts              Rarity union (14 buckets), SubType, SlotBreakdown, EvResult
  tcgcsv.ts             TCGCSV API client — fetchProducts, fetchPrices, resolveRarity, matchPrices
  calculator.ts         EV calculation — Standard/Premium branching, 5-slot model, hitBreakdown
  pull-rates-loader.ts  Three-layer config merge, oneInXPacks → decimal conversion
  spike-check.ts        TCGPlayer latestsales API — daily/weekly spike detection
  latestsales.ts        TCGPlayer mpapi POST client (browser UA spoofing)
  archive-ingest.ts     TCGCSV 7z archive download + SQLite ingest (category 68)
  price-history-db.ts   SQLite WAL — upsertPrices, queryHistory, pruneOldRows
config/
  pull-rates.global.json
  pull-rates.default.json
  pull-rates-{set-id}.json  (one per set)
public/
  index.html            Self-contained webapp (vanilla HTML/CSS/JS, no build step)
```

## Data sources

- **[TCGCSV](https://tcgcsv.com)** — card names, rarities, and live prices (~24hr TCGPlayer cache). Category ID **68** (One Piece TCG English).
- **TCGPlayer latest-sales API** — NM sales data for spike detection. No API key required (uses browser UA spoofing).

Pull rates are community estimates — Bandai does not publish official pack odds.
