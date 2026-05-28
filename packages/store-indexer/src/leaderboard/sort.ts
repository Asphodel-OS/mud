/**
 * Leaderboard sort — the only leaderboard-specific math.
 *
 * Lives next to the aggregator rather than in lib/tourneyMath because it's
 * UI ranking logic (not a contract mirror): which tiebreakers matter when a
 * user toggles between winrate / festivalWins / onyxWon.
 */

export type LeaderboardMetric = "winrate" | "festivalWins" | "onyxWon";

/** Minimal shape the comparator reads. Structural — avoids circular imports. */
export interface LeaderboardRowLike {
  wins: number;
  losses: number;
  festivalWins: number;
  onyxWon: number;
  winrate: number;
  /** True once the row hits MIN_QUALIFYING_BATTLES. Only consulted on the
   * winrate metric — onyxWon and festivalWins surface every row by amount. */
  qualified: boolean;
  bestPlacement: number;
}

/**
 * Returns a comparator for sorting leaderboard rows by the given primary metric.
 * Tiebreaker order per metric:
 *   winrate:      qualified desc (qualified before unqualified) → winrate desc → battles desc → festivalWins → bestPlacement asc
 *   onyxWon:      onyxWon → festivalWins → wins → bestPlacement asc
 *   festivalWins: festivalWins → wins → onyxWon → bestPlacement asc
 *
 * The qualified-first split keeps a 5-0 hot streak out of the winrate podium
 * while still showing the row in the list. onyxWon and festivalWins ignore
 * the qualifier — both are absolute counts that already require play volume.
 */
export function compareByMetric(metric: LeaderboardMetric): (a: LeaderboardRowLike, b: LeaderboardRowLike) => number {
  switch (metric) {
    case "onyxWon":
      return (a, b) =>
        b.onyxWon - a.onyxWon ||
        b.festivalWins - a.festivalWins ||
        b.wins - a.wins ||
        a.bestPlacement - b.bestPlacement;
    case "festivalWins":
      return (a, b) =>
        b.festivalWins - a.festivalWins ||
        b.wins - a.wins ||
        b.onyxWon - a.onyxWon ||
        a.bestPlacement - b.bestPlacement;
    default: // "winrate"
      return (a, b) =>
        Number(b.qualified) - Number(a.qualified) ||
        b.winrate - a.winrate ||
        b.wins + b.losses - (a.wins + a.losses) ||
        b.festivalWins - a.festivalWins ||
        a.bestPlacement - b.bestPlacement;
  }
}
