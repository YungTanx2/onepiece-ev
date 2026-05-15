export interface SetDef {
  id: string;       // slug — matches pull-rates-{id}.json
  name: string;     // display name
  groupId: number;  // TCGCSV group ID
}

/**
 * One Piece TCG sets supported by this tool.
 * Scope: OP-07 → OP-16 (main booster sets) + EB-01/02/03 (Extra Boosters)
 *        + Premium Booster -The Best- Vol. 2.
 *
 * `groupId` is the TCGCSV group identifier — browse new sets at:
 *   https://tcgcsv.com/tcgplayer/68/groups  (68 = One Piece category)
 * `id` must match the pull-rates config filename: config/pull-rates-{id}.json
 * Standard sets fall back to config/pull-rates.default.json if no per-set file exists.
 * To add a new set: create the config file (or rely on default) and add an entry here.
 */
export const SUPPORTED_SETS: SetDef[] = [
  // ── Main booster sets ────────────────────────────────────────────────────
  { id: 'op-07',             name: '500 Years in the Future',          groupId: 23387 },
  { id: 'op-08',             name: 'Two Legends',                      groupId: 23462 },
  { id: 'op-09',             name: 'Emperors in the New World',        groupId: 23589 },
  { id: 'op-10',             name: 'Royal Blood',                      groupId: 23766 },
  { id: 'op-11',             name: 'A Fist of Divine Speed',           groupId: 24241 },
  { id: 'op-12',             name: 'Legacy of the Master',             groupId: 24302 },
  { id: 'op-13',             name: 'Carrying On His Will',             groupId: 24303 },
  { id: 'op-14',             name: 'The Azure Sea\'s Seven',           groupId: 24537 },
  { id: 'op-15',             name: 'Adventure on Kami\'s Island',      groupId: 24637 },
  { id: 'op-16',             name: 'The Time of Battle',               groupId: 24664 },
  // ── Extra Boosters ───────────────────────────────────────────────────────
  { id: 'eb-01',             name: 'Memorial Collection',              groupId: 23333 },
  { id: 'eb-02',             name: 'Anime 25th Collection',            groupId: 23834 },
  { id: 'eb-03',             name: 'One Piece Heroines Edition',       groupId: 24545 },
  // ── Premium Boosters ─────────────────────────────────────────────────────
  { id: 'premium-best-v2',   name: 'Premium Booster -The Best- Vol. 2', groupId: 24305 },
];

/** The set shown by default when the web app loads — update to the latest active set. */
export const DEFAULT_SET_ID = 'op-15';
