import type { Affinity } from "./affinities";

export type Metric = "winrate" | "festivalWins" | "onyxWon";
export type SyncState = "syncing" | "ready" | "scale-degraded";

export interface LeaderboardRow {
  wallet: string;
  wins: number;
  losses: number;
  tournaments: number;
  /** Count of bracket-1 finishes on a Festival tournament (brackets 4/5/6). Duels do not contribute. */
  festivalWins: number;
  /** 1..8; 8 used as sentinel meaning "never placed" */
  bestPlacement: number;
  /** Raw win rate in [0, 1]: wins / (wins + losses). Zero when no battles. */
  winrate: number;
  /** True once total battles ≥ MIN_QUALIFYING_BATTLES. Unqualified rows are
   * still surfaced on the winrate leaderboard but grouped below qualified
   * players so small-sample streaks can't take the podium. */
  qualified: boolean;
  /** NET ONYX profit: total prize earnings minus entry fees, in 2dp ONYX.
   * Can be negative for players whose entry costs exceed winnings. */
  onyxWon: number;
  /** Total entry fees paid, in 2dp ONYX. */
  onyxSpent: number;
  /**
   * Sprite URL for this wallet's representative taruchi (highest index they own, any state).
   * Falls back to the silhouette placeholder if the wallet has no core records.
   */
  imageUrl: string;
}

export interface AscendedRow {
  taruchiId: bigint;
  taruchiIndex: number;
  wallet: string;
  name: string;
  affinity: Affinity;
  /** 0 until indexer block timestamps land */
  ascendedAt: number;
  imageUrl: string;
}

/** Per-individual-taruchi leaderboard row — each taruchi index gets its own
 * entry, ranked by its own lifetime W/L and ONYX net. Includes all revealed
 * tarus (active, retired, dead, ascended). Legacy champions still rank. */
export interface TaruchiLeaderboardRow {
  taruchiId: bigint;
  taruchiIndex: number;
  /** Lowercase wallet of the current owner — used for isSelf comparison. */
  ownerWallet: string;
  /** Decoded TaruchiName, or `Taruchi #N` fallback when unset. */
  name: string;
  /** TaruchiState value: 1 IDLE, 2 ENROLLED, 3 RETIRED, 4 ASCENDED, 5 DEAD. */
  state: number;
  /** Sprite from THIS taruchi's own TaruchiStatus.traits — not the owner's newest mint. */
  imageUrl: string;
  wins: number;
  losses: number;
  tournaments: number;
  /** 1..8; 8 sentinel for "never placed". */
  bestPlacement: number;
  /** Raw win rate in [0, 1]: wins / (wins + losses). Zero when no battles. */
  winrate: number;
  /** True once total battles ≥ MIN_QUALIFYING_BATTLES. Same gate as wallet rows. */
  qualified: boolean;
  /** NET ONYX profit for this specific taruchi (prizes minus its entry fees), 2dp. Can be negative. */
  onyxWon: number;
  /** Total entry fees paid enrolling this taruchi, 2dp. */
  onyxSpent: number;
}

export interface LeaderboardAggregate {
  /** Pre-sorted by wins desc, then festivalWins desc, then onyxWon desc, then bestPlacement asc. */
  overall: LeaderboardRow[];
  /** Fast per-wallet rank lookup: wallet → row. Same row reference as in `overall`. */
  byWallet: Map<string, LeaderboardRow>;
  /** Pre-sorted per-taruchi leaderboard — same sort order as `overall` (festivalWins is always 0 here and acts as a no-op tiebreaker). */
  overallByTaruchi: TaruchiLeaderboardRow[];
  /** Fast per-taruchi lookup: String(taruchiId) → row. Same row reference as in `overallByTaruchi`. */
  byTaruchi: Map<string, TaruchiLeaderboardRow>;
  /** Sorted by ascension count desc, then taruchiIndex desc (newest mint first, stand-in for ascendedAt until indexer timestamps land). */
  ascended: AscendedRow[];
  /** tourneys + duels + results combined. Used by scale-wall guard. */
  recordCount: number;
  /** ms epoch of last aggregate build. */
  computedAt: number;
}

export const EMPTY_AGGREGATE: LeaderboardAggregate = {
  overall: [],
  byWallet: new Map(),
  overallByTaruchi: [],
  byTaruchi: new Map(),
  ascended: [],
  recordCount: 0,
  computedAt: 0,
};
