import { unpackU32 } from "./packUtils";
import { AFFINITIES, type Affinity } from "./affinities";
import {
  FESTIVAL_BRACKETS,
  ENTRY_FEES,
  positionToPlacement,
  placementToWins,
  placementToBattleCount,
  calcRewardWei,
  weiTo2dpOnyx,
  rawWinrate,
  isQualified,
} from "./tourneyMath";
import { compareByMetric } from "./sort";
import type { LeaderboardAggregate, LeaderboardRow, AscendedRow, TaruchiLeaderboardRow } from "./types";
import { EMPTY_AGGREGATE } from "./types";

/** Subset of stash records we read. Narrow shapes for testability. */
export interface TourneyLike {
  id: bigint;
  status: number; // 2 = COMPLETED
  bracket: number; // 1..6
  players: bigint; // packed u32[8]
}
export interface DuelLike {
  id: bigint;
  status: number;
  bracket: number;
  playerAIndex: number;
  playerBIndex: number;
}
export interface ResultLike {
  id: bigint;
  placements: bigint; // packed u32[] — length matches player count
}
export interface CoreLike {
  id: bigint;
  owner: string;
  index: number;
}
export interface StatusLike {
  id: bigint;
  state: number; // 4 = ASCENDED
  level: number;
  affinity: number;
  traits: bigint | number;
}
export interface NameLike {
  id: bigint;
  name: string; // bytes32 hex or decoded string
}

export interface BuildAggregateInput {
  tourneys: TourneyLike[];
  duels: DuelLike[];
  results: ResultLike[];
  cores: CoreLike[];
  statuses: StatusLike[];
  names: NameLike[];
  /** Duel protocol fee BPS (5% today, used for 1v1 matches). */
  protocolFeeBps: bigint;
  /** Festival protocol fee BPS (10% today, used for 8-player festivals). */
  festivalProtocolFeeBps: bigint;
  jackpotBps: bigint;
  /** Map taruchi index → sprite URL for Ascended gallery display. */
  spriteFor: (core: CoreLike, status: StatusLike | undefined) => string;
  /** Decode bytes32 name to display string. Injected so tests don't pull viem. */
  decodeName: (name: string) => string;
  /** Wallet-lifetime referral earnings in wei, keyed by lowercase wallet. */
  referralRewardsByReferrer?: ReadonlyMap<string, { lifetimeEarnedOnyxWei: string }>;
}

/** How we accumulate into a row before sorting. Wei-precision ONYX is kept
 * during accumulation then converted to 2dp ONYX numbers at finalization, so
 * dust doesn't leak across many matches (wei math is exact; the number
 * conversion only happens once at the boundary). */
interface RowAcc {
  wallet: string;
  wins: number;
  losses: number;
  tournaments: number;
  festivalWins: number;
  bestPlacement: number;
  /** Sum of prize payouts in wei. */
  onyxEarnedWei: bigint;
  /** Sum of entry fees paid in wei. */
  onyxSpentWei: bigint;
  imageUrl: string;
}

/** Per-taruchi accumulator. Keyed by taruchiIndex — only populated for tarus
 * that actually played. Sprite/name/state are captured lazily on first touch. */
interface TaruRowAcc {
  taruchiId: bigint;
  taruchiIndex: number;
  ownerWallet: string;
  name: string;
  state: number;
  imageUrl: string;
  wins: number;
  losses: number;
  tournaments: number;
  bestPlacement: number;
  onyxEarnedWei: bigint;
  onyxSpentWei: bigint;
}

export function buildAggregate(input: BuildAggregateInput): LeaderboardAggregate {
  const {
    tourneys,
    duels,
    results,
    cores,
    statuses,
    names,
    protocolFeeBps,
    festivalProtocolFeeBps,
    jackpotBps,
    spriteFor,
    decodeName,
    referralRewardsByReferrer = new Map(),
  } = input;

  const recordCount = tourneys.length + duels.length + results.length;
  if (recordCount === 0 && cores.length === 0) return { ...EMPTY_AGGREGATE, computedAt: Date.now() };

  // index: id → placements
  const resultMap = new Map<string, bigint>();
  for (const r of results) resultMap.set(String(r.id), r.placements);

  // index: index → owner (lowercase)
  const indexToOwner = new Map<number, string>();
  const indexToCore = new Map<number, CoreLike>();
  const coreById = new Map<string, CoreLike>();
  for (const c of cores) {
    indexToOwner.set(c.index, c.owner.toLowerCase());
    indexToCore.set(c.index, c);
    coreById.set(String(c.id), c);
  }

  // index: id → status (for ASCENDED detection)
  const statusById = new Map<string, StatusLike>();
  for (const s of statuses) statusById.set(String(s.id), s);
  // index: id → name
  const nameById = new Map<string, string>();
  for (const n of names) nameById.set(String(n.id), n.name);

  // Pick one representative taruchi per wallet for the leaderboard sprite.
  // Highest index wins (newest mint), any state — podium shouldn't skip a
  // wallet just because their current roster is all dead/ascended.
  const bestCoreByOwner = new Map<string, CoreLike>();
  for (const c of cores) {
    const key = c.owner.toLowerCase();
    const prev = bestCoreByOwner.get(key);
    if (!prev || c.index > prev.index) bestCoreByOwner.set(key, c);
  }
  const spriteByOwner = new Map<string, string>();
  for (const [owner, core] of bestCoreByOwner) {
    spriteByOwner.set(owner, spriteFor(core, statusById.get(String(core.id))));
  }
  const FALLBACK_SPRITE = "/images/taruchi/taruchi_silhouette_shadow.png";

  // wallet → acc (collapsed across all brackets/tiers)
  const acc = new Map<string, RowAcc>();
  const rowFor = (wallet: string): RowAcc => {
    let row = acc.get(wallet);
    if (!row) {
      row = {
        wallet,
        wins: 0,
        losses: 0,
        tournaments: 0,
        festivalWins: 0,
        bestPlacement: 8,
        onyxEarnedWei: 0n,
        onyxSpentWei: 0n,
        imageUrl: spriteByOwner.get(wallet) ?? FALLBACK_SPRITE,
      };
      acc.set(wallet, row);
    }
    return row;
  };

  // taruchiIndex → acc. Lazily captures the taruchi's own sprite/name/state
  // the first time it plays. Returns null if the taruchi has no core or is
  // unrevealed (state === 0) — the wallet-loop fallbacks already skip those
  // cases via `indexToOwner.get(idx)`, so this is defensive.
  const taruAcc = new Map<number, TaruRowAcc>();
  const taruRowFor = (idx: number, owner: string): TaruRowAcc | null => {
    let row = taruAcc.get(idx);
    if (row) return row;
    const core = indexToCore.get(idx);
    if (!core) return null;
    const status = statusById.get(String(core.id));
    if (status && status.state === 0) return null; // unrevealed — can't have played
    const rawName = nameById.get(String(core.id));
    const name = rawName ? decodeName(rawName) : `Taruchi #${core.index}`;
    row = {
      taruchiId: core.id,
      taruchiIndex: core.index,
      ownerWallet: owner,
      name,
      state: status?.state ?? 0,
      imageUrl: spriteFor(core, status),
      wins: 0,
      losses: 0,
      tournaments: 0,
      bestPlacement: 8,
      onyxEarnedWei: 0n,
      onyxSpentWei: 0n,
    };
    taruAcc.set(idx, row);
    return row;
  };

  // Process completed 8-player tournaments
  for (const t of tourneys) {
    if (t.status !== 2) continue;
    const packed = resultMap.get(String(t.id));
    if (!packed) continue;
    const placements = unpackU32(packed);
    const players = unpackU32(t.players);
    const entryFeeWei = ENTRY_FEES[t.bracket] ?? 0n;
    const isFestival = FESTIVAL_BRACKETS.has(t.bracket);
    const isChampionFestival = t.bracket === 6;

    // Pre-index placements once per tourney so the player loop is O(P) instead
    // of O(P²) via repeated placements.indexOf — placements length is up to 8.
    const posByIdx = new Map<number, number>();
    for (let p = 0; p < placements.length; p++) posByIdx.set(placements[p], p);

    const contributed = new Set<number>();
    for (const idx of players) {
      if (contributed.has(idx)) continue;
      contributed.add(idx);
      const owner = indexToOwner.get(idx);
      if (!owner) continue;
      const pos = posByIdx.get(idx);
      if (pos === undefined) continue;
      const placement = positionToPlacement(pos, placements.length);
      const won = placementToWins(placement);
      const lost = placementToBattleCount(placement) - won;
      const rewardWei = calcRewardWei(
        entryFeeWei,
        festivalProtocolFeeBps,
        jackpotBps,
        placement,
        false,
        isFestival,
        isChampionFestival,
      );

      const row = rowFor(owner);
      row.wins += won;
      row.losses += lost;
      row.tournaments += 1;
      row.onyxEarnedWei += rewardWei;
      row.onyxSpentWei += entryFeeWei;
      if (isFestival && placement === 1) row.festivalWins += 1;
      if (placement < row.bestPlacement) row.bestPlacement = placement;

      // Mirror into per-taru accumulator. festivalWins not tracked per-taru
      // (not exposed on the TARUCHI tab's metric toggle).
      const taru = taruRowFor(idx, owner);
      if (taru) {
        taru.wins += won;
        taru.losses += lost;
        taru.tournaments += 1;
        taru.onyxEarnedWei += rewardWei;
        taru.onyxSpentWei += entryFeeWei;
        if (placement < taru.bestPlacement) taru.bestPlacement = placement;
      }
    }
  }

  // Process completed duels.
  // No per-row dedup here — `playerAIndex` and `playerBIndex` are distinct
  // by contract (DuelEnrollSystem rejects self-duels). Mirrors the tourney
  // loop's `contributed` set, which also relies on distinctness within a
  // single packed `players` word.
  for (const d of duels) {
    if (d.status !== 2) continue;
    const packed = resultMap.get(String(d.id));
    if (!packed) continue;
    const placements = unpackU32(packed);
    const entryFeeWei = ENTRY_FEES[d.bracket] ?? 0n;
    // Duel placements length is always 2 — open-code the lookup; avoids the
    // per-player Map allocation that paid off in the tourney loop.
    const p0 = placements[0];
    const p1 = placements[1];

    for (const idx of [d.playerAIndex, d.playerBIndex]) {
      const owner = indexToOwner.get(idx);
      if (!owner) continue;
      const pos = p0 === idx ? 0 : p1 === idx ? 1 : -1;
      if (pos === -1) continue;
      const placement = positionToPlacement(pos, placements.length);
      const won = placement === 1 ? 1 : 0;
      const lost = 1 - won;
      const rewardWei = calcRewardWei(entryFeeWei, protocolFeeBps, jackpotBps, placement, true, false, false);

      const row = rowFor(owner);
      row.wins += won;
      row.losses += lost;
      row.tournaments += 1;
      row.onyxEarnedWei += rewardWei;
      row.onyxSpentWei += entryFeeWei;
      // Duels never contribute to festivalWins OR bestPlacement: "best
      // placement" is a festival-podium stat, and a duel's [winner, loser]
      // pack would otherwise read as a 1st/2nd festival placement.

      // Mirror into per-taru accumulator.
      const taru = taruRowFor(idx, owner);
      if (taru) {
        taru.wins += won;
        taru.losses += lost;
        taru.tournaments += 1;
        taru.onyxEarnedWei += rewardWei;
        taru.onyxSpentWei += entryFeeWei;
      }
    }
  }

  // Finalize wei → 2dp ONYX at the boundary. `gameOnyxWon` is gameplay NET
  // (earnings minus entry fees); `onyxWon` adds wallet-level referral earnings.
  const overall: LeaderboardRow[] = [];
  const byWallet = new Map<string, LeaderboardRow>();
  for (const [wallet, a] of acc) {
    const referralLifetimeWei = BigInt(referralRewardsByReferrer.get(wallet)?.lifetimeEarnedOnyxWei ?? "0");
    const onyxSpent = weiTo2dpOnyx(a.onyxSpentWei);
    const gameOnyxWon = weiTo2dpOnyx(a.onyxEarnedWei - a.onyxSpentWei);
    const referralOnyxEarned = weiTo2dpOnyx(referralLifetimeWei);
    const row: LeaderboardRow = {
      wallet: a.wallet,
      wins: a.wins,
      losses: a.losses,
      tournaments: a.tournaments,
      festivalWins: a.festivalWins,
      bestPlacement: a.bestPlacement,
      winrate: rawWinrate(a.wins, a.losses),
      qualified: isQualified(a.wins, a.losses),
      onyxWon: weiTo2dpOnyx(a.onyxEarnedWei - a.onyxSpentWei + referralLifetimeWei),
      gameOnyxWon,
      referralOnyxEarned,
      onyxSpent,
      imageUrl: a.imageUrl,
    };
    overall.push(row);
    byWallet.set(wallet, row);
  }

  overall.sort(compareByMetric("winrate"));

  // Finalize per-taru rows. Same wei→2dp boundary, same `onyxWon = NET` rule.
  // `festivalWins: 0` is passed solely so the structural comparator accepts
  // these rows — the TARUCHI tab never surfaces the festival metric.
  const overallByTaruchi: TaruchiLeaderboardRow[] = [];
  const byTaruchi = new Map<string, TaruchiLeaderboardRow>();
  for (const a of taruAcc.values()) {
    const row: TaruchiLeaderboardRow = {
      taruchiId: a.taruchiId,
      taruchiIndex: a.taruchiIndex,
      ownerWallet: a.ownerWallet,
      name: a.name,
      state: a.state,
      imageUrl: a.imageUrl,
      wins: a.wins,
      losses: a.losses,
      tournaments: a.tournaments,
      bestPlacement: a.bestPlacement,
      winrate: rawWinrate(a.wins, a.losses),
      qualified: isQualified(a.wins, a.losses),
      onyxWon: weiTo2dpOnyx(a.onyxEarnedWei - a.onyxSpentWei),
      onyxSpent: weiTo2dpOnyx(a.onyxSpentWei),
    };
    overallByTaruchi.push(row);
    byTaruchi.set(String(a.taruchiId), row);
  }
  // Taru rows have no festivalWins. Qualified rows sort ahead of unqualified
  // (mirrors compareByMetric("winrate")), then winrate desc, then battles desc
  // as the experience-weight tiebreaker.
  overallByTaruchi.sort(
    (a, b) =>
      Number(b.qualified) - Number(a.qualified) ||
      b.winrate - a.winrate ||
      b.wins + b.losses - (a.wins + a.losses) ||
      a.bestPlacement - b.bestPlacement,
  );

  // Ascended: every taruchi whose status = ASCENDED (4).
  // Sprite comes from the ascended taruchi itself (its own traits/status),
  // NOT from the wallet's highest-index representative — gallery rows show
  // the specific taruchi that ascended, not the owner's newest mint.
  const ascended: AscendedRow[] = [];
  for (const s of statuses) {
    if (s.state !== 4) continue;
    const core = coreById.get(String(s.id));
    if (!core) continue;
    const rawName = nameById.get(String(s.id));
    const name = rawName ? decodeName(rawName) : `Taruchi #${core.index}`;
    const affinity: Affinity = AFFINITIES[s.affinity] ?? "Normal";
    ascended.push({
      taruchiId: s.id,
      taruchiIndex: core.index,
      wallet: core.owner.toLowerCase(),
      name,
      affinity,
      // TODO(indexer): replace with block timestamp once indexer __meta lands.
      ascendedAt: 0,
      imageUrl: spriteFor(core, s),
    });
  }
  // Sort ascended: by wallet count desc first (via secondary pass), then newest first
  const countByWallet = new Map<string, number>();
  for (const a of ascended) countByWallet.set(a.wallet, (countByWallet.get(a.wallet) ?? 0) + 1);
  ascended.sort((a, b) => {
    const diff = (countByWallet.get(b.wallet) ?? 0) - (countByWallet.get(a.wallet) ?? 0);
    if (diff !== 0) return diff;
    return b.taruchiIndex - a.taruchiIndex; // newest first as a stand-in for ascendedAt
  });

  return { overall, byWallet, overallByTaruchi, byTaruchi, ascended, recordCount, computedAt: Date.now() };
}
