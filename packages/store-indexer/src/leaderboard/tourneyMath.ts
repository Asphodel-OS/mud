/**
 * Tourney math — contract mirror.
 *
 * Single client-side source of truth for tournament/duel bracket identity,
 * placement mapping, entry fees, and prize distribution. Mirrors
 * the Solidity game contracts exactly:
 *   - LibOnyx.calcTourneyPrizeDistribution / calcDuelPrizeDistribution
 *   - LibTourney.stop (position packing order)
 *   - TourneyResolveSystem.winnerTakeAll logic
 *
 * Callers (usePlayerStats, LeaderboardProvider, buildAggregate, ArenaScreen)
 * import from here so that profile stats and leaderboard totals cannot drift
 * from each other — if either diverges from Solidity, update this file and
 * both callers get the fix for free.
 *
 * When aggregation migrates to a Postgres materialized view, this file
 * becomes the SQL. Keep it pure — no React, no stash, no I/O.
 */

import { parseEther } from "viem";

// =============================================================================
// Bracket identity
// =============================================================================

type BracketTier = "rookie" | "veteran" | "champion";
export type BracketLabel =
  | "rookie"
  | "veteran"
  | "champion"
  | "rookieFestival"
  | "veteranFestival"
  | "championFestival";

/** Festival brackets (enum values 4, 5, 6). */
export const FESTIVAL_BRACKETS = new Set([4, 5, 6]);

/** Contract bracket enum value → full bracket label. */
export const BRACKET_NAMES: Record<number, BracketLabel> = {
  1: "rookie",
  2: "veteran",
  3: "champion",
  4: "rookieFestival",
  5: "veteranFestival",
  6: "championFestival",
};

/** Contract bracket enum value → bracket tier (regular + festival collapse together). */
export const BRACKET_TO_TIER: Record<number, BracketTier> = {
  1: "rookie",
  4: "rookie",
  2: "veteran",
  5: "veteran",
  3: "champion",
  6: "champion",
};

/** Players per festival tournament. */
const NUM_PLAYERS = 8;

// =============================================================================
// Fee constants — entry fees + LibOnyx BPS / Config key live in `common/onyxConstants.ts`.
// Re-exported here so prize math imports stay on one module.
// =============================================================================

export const ENTRY_FEES: Record<number, bigint> = {
  1: parseEther("2"), // ROOKIE
  2: parseEther("5"), // VETERAN
  3: parseEther("10"), // CHAMPION
  4: parseEther("5"), // ROOKIE_FESTIVAL   (GDD §10.1: festival entry above duel)
  5: parseEther("10"), // VETERAN_FESTIVAL  (GDD §10.1)
  6: parseEther("15"), // CHAMPION_FESTIVAL (GDD §10.1)
};

export {
  CONFIG_KEY_JACKPOT_BALANCE,
  ONYX_JACKPOT_PAYOUT_BPS,
  ONYX_PROTOCOL_FEE_BPS,
  ONYX_TOURNEY_JACKPOT_BPS,
} from "./onyxConstants";

import {
  ONYX_L11_PRIZE_1ST,
  ONYX_L11_PRIZE_2ND,
  ONYX_L11_PRIZE_3RD,
  ONYX_L11_PRIZE_4TH,
  ONYX_L22_PRIZE_1ST,
  ONYX_L22_PRIZE_2ND,
  ONYX_L22_PRIZE_3RD,
  ONYX_L22_PRIZE_4TH,
  ONYX_L33_PRIZE_1ST,
} from "./onyxConstants";

// =============================================================================
// Placement mapping — mirrors LibTourney.stop() packing order
// =============================================================================

/**
 * Map packed-array position to placement tier.
 * 8-player tournaments: [0]=1st, [7]=2nd, [3|6]=3rd, [1|2|4|5]=5th
 * 2-player duels:       [0]=1st, [1]=2nd
 */
export function positionToPlacement(pos: number, arrayLength: number): number {
  if (pos === 0) return 1;
  if (arrayLength <= 2) return 2;
  if (pos === 7) return 2;
  if (pos === 3 || pos === 6) return 3;
  return 5;
}

/** Battles fought per placement tier (everyone fights at least QF). */
export function placementToBattleCount(placement: number): number {
  if (placement <= 2) return 3;
  if (placement <= 4) return 2;
  return 1;
}

/** Battles WON per placement tier. */
export function placementToWins(placement: number): number {
  if (placement === 1) return 3;
  if (placement === 2) return 2;
  if (placement === 3) return 1;
  return 0;
}

// =============================================================================
// Reward math — mirrors LibOnyx.calcPrizeDistribution exactly
//
// Wei-returning cores are the primary implementation (full precision, used by
// the leaderboard aggregator for accurate net-ONYX sums). The `number`-returning
// wrappers below keep legacy callers (usePlayerStats) on integer whole-ONYX
// behavior — changing that would require a broader display pass.
// =============================================================================

/** Festival reward in wei — diagram-hardcoded placements. Mirrors
 *  LibOnyx.calcTourneyPrizeDistribution (ECONOMY.md §4.3):
 *    L11 (entry 5 ONYX): 24/15/9/9 = 57 total
 *    L22 (entry 10):     69/27/9/9 = 114
 *    L33 (entry 15, WTA): 152 total (+ 10% jackpot tail handled by caller)
 *  protocolFeeBps + jackpotBps stay in the signature for the legacy non-festival
 *  WTA fallback (8-player tourneys outside the festival enum). */
export function calcFestivalRewardWei(
  entryFee: bigint,
  protocolFeeBps: bigint,
  jackpotBps: bigint,
  placement: number,
  winnerTakeAll: boolean,
): bigint {
  // Festival dispatch keyed by entry fee (the only signal the caller can pass
  // without a Bracket enum). The contract uses bracket directly; this mapping
  // works because no two festival brackets share an entry fee.
  //
  // Placement 4 is semantically valid (diagram L11/L22 4TH = 9 ether) but
  // unreachable from `positionToPlacement`, which only emits 1 | 2 | 3 | 5.
  // Both 3rd-place bracket positions (array indices 3 and 6) collapse to
  // placement=3. The 4TH constants are kept for parity with the contract's
  // 4-element placements array returned by `calcTourneyPrizeDistribution`;
  // callers that pass placement=4 directly (e.g., unit tests) get the diagram
  // value.
  if (entryFee === ENTRY_FEES[4] && !winnerTakeAll) {
    // ROOKIE_FESTIVAL — 24/15/9/9
    if (placement === 1) return ONYX_L11_PRIZE_1ST;
    if (placement === 2) return ONYX_L11_PRIZE_2ND;
    if (placement === 3) return ONYX_L11_PRIZE_3RD;
    if (placement === 4) return ONYX_L11_PRIZE_4TH;
    return 0n;
  }
  if (entryFee === ENTRY_FEES[5] && !winnerTakeAll) {
    // VETERAN_FESTIVAL — 69/27/9/9
    if (placement === 1) return ONYX_L22_PRIZE_1ST;
    if (placement === 2) return ONYX_L22_PRIZE_2ND;
    if (placement === 3) return ONYX_L22_PRIZE_3RD;
    if (placement === 4) return ONYX_L22_PRIZE_4TH;
    return 0n;
  }
  if (entryFee === ENTRY_FEES[6] && winnerTakeAll) {
    // CHAMPION_FESTIVAL — 152 WTA (+ jackpot tail handled separately)
    return placement === 1 ? ONYX_L33_PRIZE_1ST : 0n;
  }

  // Legacy non-festival 8-player tourney WTA fallback — entry-pool prize after rakes.
  const totalPool = entryFee * BigInt(NUM_PLAYERS);
  const protocolFee = (totalPool * protocolFeeBps) / 10000n;
  const jackpotFee = (totalPool * jackpotBps) / 10000n;
  const prizePool = totalPool - protocolFee - jackpotFee;
  return placement === 1 ? prizePool : 0n;
}

/** Duel reward in wei — winner gets totalPool minus protocol only (matches LibOnyx.calcDuelPrizeDistribution). */
export function calcDuelRewardWei(entryFee: bigint, protocolFeeBps: bigint, placement: number): bigint {
  if (placement !== 1) return 0n;
  const totalPool = entryFee * 2n;
  const protocolFee = (totalPool * protocolFeeBps) / 10000n;
  return totalPool - protocolFee;
}

/**
 * Unified reward calc in wei. Dispatches to duel or festival calc based on
 * flags. Winner-take-all mirrors TourneyResolveSystem.sol exactly:
 *   winnerTakeAll = !isFestival || bracket == Bracket.CHAMPION_FESTIVAL
 * So non-festival tournaments (currently unreachable via the festival-only
 * enroll gate, but kept correct for future contract changes) also take the
 * winner-take-all branch.
 */
export function calcRewardWei(
  entryFee: bigint,
  protocolFeeBps: bigint,
  jackpotBps: bigint,
  placement: number,
  isDuel: boolean,
  isFestival: boolean,
  isChampionFestival: boolean,
): bigint {
  if (isDuel) return calcDuelRewardWei(entryFee, protocolFeeBps, placement);
  const winnerTakeAll = !isFestival || isChampionFestival;
  return calcFestivalRewardWei(entryFee, protocolFeeBps, jackpotBps, placement, winnerTakeAll);
}

/** Whole-ONYX wrapper (floors, preserves legacy behavior). */
export function calcFestivalReward(
  entryFee: bigint,
  protocolFeeBps: bigint,
  jackpotBps: bigint,
  placement: number,
  winnerTakeAll: boolean,
): number {
  return Number(calcFestivalRewardWei(entryFee, protocolFeeBps, jackpotBps, placement, winnerTakeAll) / 10n ** 18n);
}

/** Whole-ONYX wrapper (floors, preserves legacy behavior). */
export function calcDuelReward(entryFee: bigint, protocolFeeBps: bigint, placement: number): number {
  return Number(calcDuelRewardWei(entryFee, protocolFeeBps, placement) / 10n ** 18n);
}

/** Whole-ONYX wrapper (floors, preserves legacy behavior). */
export function calcReward(
  entryFee: bigint,
  protocolFeeBps: bigint,
  jackpotBps: bigint,
  placement: number,
  isDuel: boolean,
  isFestival: boolean,
  isChampionFestival: boolean,
): number {
  return Number(
    calcRewardWei(entryFee, protocolFeeBps, jackpotBps, placement, isDuel, isFestival, isChampionFestival) / 10n ** 18n,
  );
}

/** Returns entry fee in whole ONYX (rounds down, matches contract storage). */
export function entryFeeOnyx(bracket: number): number {
  const wei = ENTRY_FEES[bracket] ?? 0n;
  return Number(wei / 10n ** 18n);
}

/** Convert wei (positive or negative) to ONYX with 2 decimals. Sign-safe so
 * net calculations (earnings minus entry fees) read as e.g. `-3.20`. Same
 * precision pattern useAscensionJackpot.balance2dp uses. */
export function weiTo2dpOnyx(wei: bigint): number {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const cents = abs / 10n ** 16n; // 2 decimals of ONYX as bigint
  const value = Number(cents) / 100;
  return neg ? -value : value;
}

// =============================================================================
// Winrate — raw rate + minimum-games qualifier
// =============================================================================

/** Battles required before a row qualifies for the winrate leaderboard.
 * Sub-threshold rows still appear, but are grouped under an "unqualified"
 * section so a 5-0 lucky streak can't take the podium. */
export const MIN_QUALIFYING_BATTLES = 10;

/** Raw winrate in [0, 1]. Zero battles → 0 (no games played, no rate). */
export function rawWinrate(wins: number, losses: number): number {
  const battles = wins + losses;
  return battles > 0 ? wins / battles : 0;
}

/** True once the row has played enough battles to be ranked on the winrate
 * leaderboard. Below this, the row is still visible but sorted into the
 * "unqualified" section. */
export function isQualified(wins: number, losses: number): boolean {
  return wins + losses >= MIN_QUALIFYING_BATTLES;
}
