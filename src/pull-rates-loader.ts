import fs from 'fs';
import path from 'path';

/**
 * Raw shape of a pull-rates JSON file.
 * Rates are stored as { oneInXPacks: N } objects — human-readable inverse probabilities.
 * The loader converts them to per-pack decimals (1/N) before returning.
 */
interface RawRate {
  oneInXPacks: number;
}

interface RawPullRates {
  packsPerBox?: number;
  commonCount?: number;
  uncommonCount?: number;
  rareCount?: number;
  leaderProbabilityPerPack?: RawRate;
  hitDistribution?: Record<string, RawRate>;
}

/**
 * Resolved pull rates — all rates converted to per-pack decimals.
 * Consumed directly by calculator.ts.
 */
export interface ResolvedPullRates {
  packsPerBox: number;
  /** Defined for Standard boxes; undefined for Premium (no filler slots). */
  commonCount?: number;
  uncommonCount?: number;
  rareCount?: number;
  /** P(leader per pack). Defined for Standard boxes only. */
  leaderPerPack?: number;
  /** Per-pack probability for each hit-slot rarity. Keys are Rarity bucket names. */
  hitDistribution: Record<string, number>;
  /** True when the box has filler C/UC/R slots (Standard). False for all-hits Premium. */
  isStandard: boolean;
}

const CONFIG_DIR = path.join(__dirname, '..', 'config');

/**
 * Load and deep-merge pull-rate configs in priority order:
 *   global  (pull-rates.global.json)  — flat rates that apply to every product
 *   default (pull-rates.default.json) — Standard booster baseline (24-pack OP-XX/EB)
 *   per-set (pull-rates-{setId}.json) — set-specific overrides; required for Premium sets
 *
 * Each layer overrides the previous. Rates stored as { oneInXPacks: N } are
 * converted to per-pack decimals (1/N) in the resolved output.
 *
 * @param setId - Matches the `id` field in sets.ts (e.g. 'op-15', 'premium-best-v2')
 */
export function loadPullRates(setId: string): ResolvedPullRates {
  const globalRaw  = loadRaw('pull-rates.global.json');
  const defaultRaw = loadRaw('pull-rates.default.json');
  const setRaw     = loadRaw(`pull-rates-${setId}.json`);

  // Warn if per-set overrides a globally-flat key
  if (setRaw?.hitDistribution && globalRaw?.hitDistribution) {
    for (const key of Object.keys(setRaw.hitDistribution)) {
      if (globalRaw.hitDistribution[key] !== undefined) {
        console.warn(
          `[pull-rates] Warning: per-set config for "${setId}" overrides globally-flat rate for "${key}".`,
        );
      }
    }
  }

  // Merge hitDistribution: global → default → per-set
  const mergedHitRaw: Record<string, RawRate> = {
    ...(globalRaw?.hitDistribution  ?? {}),
    ...(defaultRaw?.hitDistribution ?? {}),
    ...(setRaw?.hitDistribution     ?? {}),
  };

  // If the per-set config supplies its own packsPerBox, it is a self-contained spec
  // (e.g. Premium Booster). Skip inheriting Standard filler-slot fields from default
  // so commonCount/uncommonCount/rareCount/leaderProbabilityPerPack don't bleed in.
  // Standard per-set overrides never have their own packsPerBox, so they fall through.
  const useDefault = !setRaw?.packsPerBox;
  const merged: RawPullRates = {
    ...(useDefault ? defaultRaw : {}),
    ...setRaw,
    hitDistribution: mergedHitRaw,
  };

  if (!merged.packsPerBox) {
    throw new Error(`[pull-rates] No packsPerBox found for set "${setId}" — add to default or per-set config.`);
  }

  // Convert all RawRate objects to per-pack decimal probabilities
  const hitDistribution: Record<string, number> = {};
  for (const [rarity, rate] of Object.entries(mergedHitRaw)) {
    if (rate.oneInXPacks <= 0) {
      console.warn(`[pull-rates] Invalid oneInXPacks value ${rate.oneInXPacks} for "${rarity}" — skipping.`);
      continue;
    }
    hitDistribution[rarity] = 1 / rate.oneInXPacks;
  }

  const leaderPerPack = merged.leaderProbabilityPerPack
    ? 1 / merged.leaderProbabilityPerPack.oneInXPacks
    : undefined;

  const isStandard = typeof merged.commonCount === 'number';

  return {
    packsPerBox:  merged.packsPerBox,
    commonCount:  merged.commonCount,
    uncommonCount: merged.uncommonCount,
    rareCount:    merged.rareCount,
    leaderPerPack,
    hitDistribution,
    isStandard,
  };
}

/** Load a JSON config file from config/. Returns null if the file doesn't exist. */
function loadRaw(filename: string): RawPullRates | null {
  const filePath = path.join(CONFIG_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawPullRates;
  } catch {
    return null;
  }
}
