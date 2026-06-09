/**
 * Per-taruchi detail builder — the data behind a single Taru's Fighter Card,
 * served by `GET /api/taruchi/:id`, where `:id` is the onchain uint256
 * Taruchi id (not the visible Taruchi index).
 *
 * Combines, for every owned taruchi (incl. never-played):
 *   - onchain status: level, xp, training points, affinity, state, bud index
 *   - unpacked traits (5 slots + the CDN trait code) and combat stats (int16×4)
 *   - lifetime record (reused from the leaderboard's `byTaruchi` aggregate so
 *     the card and the TARUCHI leaderboard can never drift)
 *   - a per-tier W/L breakdown (rookie / veteran / champion) computed here with
 *     the SAME placement math `buildAggregate` uses, so the tiers sum to the
 *     overall record
 *   - ascension flag
 *
 * Pure: no SQL, no I/O. `spriteFor` and `decodeName` are injected the same way
 * `buildAggregate` injects them, so this stays testable without viem/CDN config.
 */

import { unpackU32 } from "./packUtils";
import { BRACKET_TO_TIER, positionToPlacement, placementToWins, placementToBattleCount } from "./tourneyMath";
import type { CoreLike, DuelLike, NameLike, ResultLike, TourneyLike } from "./buildAggregate";
import type { TaruchiLeaderboardRow } from "./types";

/** Decoded combat stats (mirror of game2 LibStats.unpack). */
export interface TaruchiStatsValues {
  health: number;
  power: number;
  harmony: number;
  violence: number;
}

/** Decoded visual traits (mirror of game2 trait packing). */
export interface TaruchiTraitsValues {
  body: number;
  eye: number;
  mouth: number;
  equipment: number;
  flower: number;
}

/** Lifetime record for one taruchi (zeroed for tarus that never played). */
export interface TaruchiDetailRecord {
  wins: number;
  losses: number;
  tournaments: number;
  /** 1..8; 8 = never placed. */
  bestPlacement: number;
  winrate: number;
  qualified: boolean;
  onyxWon: number;
  onyxSpent: number;
}

export interface BracketWinLoss {
  wins: number;
  losses: number;
}

/** Per-tier W/L (festival and regular brackets collapse into their tier). */
export interface TaruchiBracketRecord {
  rookie: BracketWinLoss;
  veteran: BracketWinLoss;
  champion: BracketWinLoss;
}

/** Everything about one taruchi — Fighter-Card-ready. bigint id as string for JSON. */
export interface TaruchiDetail {
  taruchiId: string;
  index: number;
  ownerWallet: string;
  name: string;
  /** TaruchiState value: 1 IDLE, 2 ENROLLED, 3 RETIRED, 4 ASCENDED, 5 DEAD. */
  state: number;
  level: number;
  xp: number;
  trainingPoints: number;
  /** Numeric onchain affinity (index into AFFINITIES). */
  affinity: number;
  /** Bud index captured at evolveBud (NFT lineage); 0 if unset. */
  budIndex: number;
  imageUrl: string;
  /** 10-char CDN trait code BBEEMMEEFF (body/eye/mouth/equipment/flower). */
  traitCode: string;
  traits: TaruchiTraitsValues;
  stats: TaruchiStatsValues;
  record: TaruchiDetailRecord;
  bracketRecord: TaruchiBracketRecord;
  ascended: boolean;
  /** 0 until indexer block timestamps land (mirrors the ascended gallery). */
  ascendedAt: number;
}

/** Onchain TaruchiStatus row (decoded). Superset of buildAggregate's StatusLike. */
export interface TaruchiStatusRow {
  id: bigint;
  state: number;
  level: number;
  xp: number;
  trainingPoints: number;
  affinity: number;
  budIndex: number;
  /** packed uint40 */
  traits: bigint;
  /** packed uint128 (int16×4) */
  stats: bigint;
}

export interface BuildTaruchiDetailsInput {
  tourneys: TourneyLike[];
  duels: DuelLike[];
  results: ResultLike[];
  cores: CoreLike[];
  statuses: TaruchiStatusRow[];
  names: NameLike[];
  /** Per-taruchi lifetime record from the leaderboard aggregate (string id → row). */
  byTaruchi: Map<string, TaruchiLeaderboardRow>;
  spriteFor: (core: CoreLike, status: TaruchiStatusRow | undefined) => string;
  decodeName: (name: string) => string;
}

const TARUCHI_STATE_UNREVEALED = 0;
const TARUCHI_STATE_ASCENDED = 4;
const NEVER_PLACED = 8;
const MASK_16 = 0xffffn;
const pad2 = (n: number): string => String(n).padStart(2, "0");

function toInt16(value: bigint): number {
  const u = Number(value & MASK_16);
  return u >= 0x8000 ? u - 0x10000 : u;
}

/** uint128 → {health,power,harmony,violence}. Mirrors game2 LibStats.unpack. */
export function unpackStats(packed: bigint): TaruchiStatsValues {
  return {
    health: toInt16(packed & MASK_16),
    power: toInt16((packed >> 16n) & MASK_16),
    harmony: toInt16((packed >> 32n) & MASK_16),
    violence: toInt16((packed >> 48n) & MASK_16),
  };
}

/** uint40 → trait slots. Layout: flower | body<<8 | eye<<16 | mouth<<24 | equipment<<32. */
export function unpackTraits(raw: bigint): TaruchiTraitsValues {
  const pack = raw & ((1n << 40n) - 1n);
  return {
    flower: Number(pack & 0xffn),
    body: Number((pack >> 8n) & 0xffn),
    eye: Number((pack >> 16n) & 0xffn),
    mouth: Number((pack >> 24n) & 0xffn),
    equipment: Number((pack >> 32n) & 0xffn),
  };
}

/** 10-char CDN code BBEEMMEEFF. Mirrors game2 getTaruchiTraitCode. */
export function traitCode(t: TaruchiTraitsValues): string {
  return pad2(t.body) + pad2(t.eye) + pad2(t.mouth) + pad2(t.equipment) + pad2(t.flower);
}

const emptyRecord = (): TaruchiDetailRecord => ({
  wins: 0,
  losses: 0,
  tournaments: 0,
  bestPlacement: NEVER_PLACED,
  winrate: 0,
  qualified: false,
  onyxWon: 0,
  onyxSpent: 0,
});

const emptyBracketRecord = (): TaruchiBracketRecord => ({
  rookie: { wins: 0, losses: 0 },
  veteran: { wins: 0, losses: 0 },
  champion: { wins: 0, losses: 0 },
});

export function buildTaruchiDetails(input: BuildTaruchiDetailsInput): Map<string, TaruchiDetail> {
  const { tourneys, duels, results, cores, statuses, names, byTaruchi, spriteFor, decodeName } = input;

  const statusById = new Map(statuses.map((s) => [String(s.id), s]));
  const coreByIndex = new Map(cores.map((c) => [c.index, c]));
  const nameById = new Map(names.map((n) => [String(n.id), n.name]));
  const resultById = new Map(results.map((r) => [String(r.id), r.placements]));
  const shouldAccumulateIndex = (idx: number): boolean => {
    const core = coreByIndex.get(idx);
    if (!core) return false;
    return statusById.get(String(core.id))?.state !== TARUCHI_STATE_UNREVEALED;
  };

  // Per-tier W/L, keyed by taruchi index, using the SAME placement → won/lost
  // math as buildAggregate so the tiers sum to the overall record.
  const bracketByIndex = new Map<number, TaruchiBracketRecord>();
  const bucketFor = (idx: number): TaruchiBracketRecord => {
    let b = bracketByIndex.get(idx);
    if (!b) {
      b = emptyBracketRecord();
      bracketByIndex.set(idx, b);
    }
    return b;
  };

  for (const t of tourneys) {
    if (t.status !== 2) continue;
    const packed = resultById.get(String(t.id));
    if (!packed) continue;
    const tier = BRACKET_TO_TIER[t.bracket];
    if (!tier) continue;
    const placements = unpackU32(packed);
    const players = unpackU32(t.players);
    const posByIdx = new Map<number, number>();
    for (let p = 0; p < placements.length; p++) posByIdx.set(placements[p], p);
    const seen = new Set<number>();
    for (const idx of players) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (!shouldAccumulateIndex(idx)) continue;
      const pos = posByIdx.get(idx);
      if (pos === undefined) continue;
      const placement = positionToPlacement(pos, placements.length);
      const won = placementToWins(placement);
      const lost = placementToBattleCount(placement) - won;
      const bucket = bucketFor(idx)[tier];
      bucket.wins += won;
      bucket.losses += lost;
    }
  }

  for (const d of duels) {
    if (d.status !== 2) continue;
    const packed = resultById.get(String(d.id));
    if (!packed) continue;
    const tier = BRACKET_TO_TIER[d.bracket];
    if (!tier) continue;
    const placements = unpackU32(packed);
    const p0 = placements[0];
    const p1 = placements[1];
    for (const idx of [d.playerAIndex, d.playerBIndex]) {
      if (!shouldAccumulateIndex(idx)) continue;
      const pos = p0 === idx ? 0 : p1 === idx ? 1 : -1;
      if (pos === -1) continue;
      const placement = positionToPlacement(pos, placements.length);
      const won = placement === 1 ? 1 : 0;
      const bucket = bucketFor(idx)[tier];
      bucket.wins += won;
      bucket.losses += 1 - won;
    }
  }

  const details = new Map<string, TaruchiDetail>();
  for (const core of cores) {
    const id = String(core.id);
    const status = statusById.get(id);
    const decoded = decodeName(nameById.get(id) ?? "");
    const traits = unpackTraits(status?.traits ?? 0n);
    const lb = byTaruchi.get(id);
    const record: TaruchiDetailRecord = lb
      ? {
          wins: lb.wins,
          losses: lb.losses,
          tournaments: lb.tournaments,
          bestPlacement: lb.bestPlacement,
          winrate: lb.winrate,
          qualified: lb.qualified,
          onyxWon: lb.onyxWon,
          onyxSpent: lb.onyxSpent,
        }
      : emptyRecord();

    details.set(id, {
      taruchiId: id,
      index: core.index,
      ownerWallet: core.owner.toLowerCase(),
      name: decoded || `Taruchi #${core.index}`,
      state: status?.state ?? 0,
      level: status?.level ?? 0,
      xp: status?.xp ?? 0,
      trainingPoints: status?.trainingPoints ?? 0,
      affinity: status?.affinity ?? 0,
      budIndex: status?.budIndex ?? 0,
      imageUrl: spriteFor(core, status),
      traitCode: traitCode(traits),
      traits,
      stats: unpackStats(status?.stats ?? 0n),
      record,
      bracketRecord: bracketByIndex.get(core.index) ?? emptyBracketRecord(),
      ascended: status?.state === TARUCHI_STATE_ASCENDED,
      ascendedAt: 0,
    });
  }

  return details;
}
