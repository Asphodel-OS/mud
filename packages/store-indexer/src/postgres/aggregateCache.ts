import { Sql } from "postgres";
import { Observable, Subscription } from "rxjs";
import { hexToString, type Hex } from "viem";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import { buildAggregate } from "../leaderboard/buildAggregate";
import { buildTaruchiDetails, type TaruchiDetail, type TaruchiStatusRow } from "../leaderboard/buildTaruchiDetails";
import { unpackU32 } from "../leaderboard/packUtils";
import { positionToPlacement } from "../leaderboard/tourneyMath";
import {
  ONYX_PROTOCOL_FEE_BPS,
  ONYX_FESTIVAL_PROTOCOL_FEE_BPS,
  ONYX_TOURNEY_JACKPOT_BPS,
} from "../leaderboard/onyxConstants";
import { EMPTY_AGGREGATE, type LeaderboardAggregate, type LeaderboardRow } from "../leaderboard/types";
import { logger } from "../logger";

const log = logger.child({ component: "leaderboard-cache" });
const mudSchemaName = transformSchemaName("mud");

// ── Server-side adapters (NOT part of the ported game2 closure) ─────────────
// game2 injects spriteFor / decodeName into buildAggregate; we supply server
// equivalents here. spriteFor mirrors game2's getTaruchiImageUrl /
// unpackTraitsForUrl, but takes the CDN base as a parameter (env-driven) rather
// than hardcoding it, so the indexer isn't coupled to a fixed CDN.

const PLACEHOLDER_SPRITE = "/images/taruchi/taruchi_silhouette_shadow.png";
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Mirror of game2 `unpackTraitsForUrl` + `getTaruchiImageUrl`. traits is the
 *  packed uint40: flower | body<<8 | eye<<16 | mouth<<24 | equipment<<32. */
function traitsImageUrl(rawTraits: bigint | number | undefined, cdnBase: string): string {
  if (rawTraits == null) return PLACEHOLDER_SPRITE;
  const pack = BigInt(rawTraits) & ((1n << 40n) - 1n);
  const flower = Number(pack & 0xffn);
  const body = Number((pack >> 8n) & 0xffn);
  const eye = Number((pack >> 16n) & 0xffn);
  const mouth = Number((pack >> 24n) & 0xffn);
  const equipment = Number((pack >> 32n) & 0xffn);
  const code = pad2(body) + pad2(eye) + pad2(mouth) + pad2(equipment) + pad2(flower);
  return `${cdnBase}/${code}.png`;
}

/** bytes32 hex → trimmed UTF-8 name; "" for unset (all-zero) so buildAggregate's
 *  `Taruchi #N` fallback fires. Should match game2's decodeBytes32Name. */
function decodeBytes32Name(hex: string | null | undefined): string {
  if (!hex || !hex.startsWith("0x")) return "";
  try {
    return (hexToString(hex as Hex).split("\u0000")[0] ?? "").trim();
  } catch {
    return "";
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

/** One taruchi in a trainer's roster — includes zero-match tarus (the leaderboard
 *  aggregate only carries tarus that have played). bigint ids are strings for JSON. */
export interface TrainerRosterEntry {
  taruchiId: string;
  index: number;
  name: string;
  state: number;
  level: number;
  affinity: number;
  imageUrl: string;
}

/** One participant in a match summary. bigint id as string for JSON. */
export interface MatchParticipant {
  taruchiId: string;
  index: number;
  /** Current owner (lowercased) — lets the client tell mine-vs-opponent and show the trainer. */
  ownerAddress: string;
  name: string;
  imageUrl: string;
  /** Finishing placement (1 = winner). Festival ranks via positionToPlacement (contract slot → rank). */
  placement: number;
}

/** A finished match (duel or festival) a wallet's taru was in — archive-card-ready.
 *  Full replay loads on click via keyed /api/logs (matchId). */
export interface MatchSummary {
  matchId: string;
  type: "duel" | "festival";
  bracket: number;
  /** TourneyResult.time (unix seconds); 0 if unset. */
  time: number;
  /** Participants sorted by placement (1st first); each carries ownerAddress + placement. */
  participants: MatchParticipant[];
}

export interface LeaderboardCache {
  isReady(): boolean;
  /** Empty aggregate until the first build succeeds. */
  getAggregate(): LeaderboardAggregate;
  /** Stats row for a wallet (lowercased), or null. */
  getStats(wallet: string): LeaderboardRow | null;
  /** All tarus owned by a wallet (lowercased), incl. zero-match. */
  getRoster(wallet: string): TrainerRosterEntry[];
  /** The wallet's finished matches (newest first) for the Mine archive. */
  getBattles(wallet: string): MatchSummary[];
  /** Full Fighter-Card detail for one taruchi by onchain uint256 id, or null if unknown. */
  getTaruchi(id: string): TaruchiDetail | null;
  computedAt(): number;
  /** MUD config block used by the current aggregate; null until first successful build. */
  indexedBlock(): bigint | null;
  /** Force an immediate rebuild and await it. Used by signing paths that cannot serve a debounced snapshot. */
  rebuildNow(): Promise<void>;
  /** Wire a recompute to a block stream (debounced) + kick the first build. */
  start(block$: Observable<unknown>): void;
  stop(): void;
}

type CacheState = {
  aggregate: LeaderboardAggregate;
  rosterByOwner: Map<string, TrainerRosterEntry[]>;
  matchesByOwner: Map<string, MatchSummary[]>;
  detailById: Map<string, TaruchiDetail>;
  computedAt: number;
  indexedBlock: bigint | null;
};

const EMPTY_STATE: CacheState = {
  aggregate: EMPTY_AGGREGATE,
  rosterByOwner: new Map(),
  matchesByOwner: new Map(),
  detailById: new Map(),
  computedAt: 0,
  indexedBlock: null,
};

export function createLeaderboardCache(
  sql: Sql,
  opts: { storeAddress: Hex; cdnBase: string; debounceMs?: number; retryMs?: number },
): LeaderboardCache {
  const debounceMs = opts.debounceMs ?? 60_000;
  const retryMs = opts.retryMs ?? 10_000;
  // Decoded MUD tables live in a schema named after the lowercased store address.
  const schema = opts.storeAddress.toLowerCase();
  const spriteFor = (_core: unknown, status: { traits?: bigint | number } | undefined): string =>
    traitsImageUrl(status?.traits, opts.cdnBase);

  let state: CacheState = EMPTY_STATE;
  let ready = false;
  let building = false;
  let buildPromise: Promise<void> | undefined;
  let forcedBuildPromise: Promise<void> | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let sub: Subscription | undefined;
  let stopped = false;

  async function fetchAndBuild(): Promise<CacheState> {
    // uint256/uint40 packed fields → ::text then BigInt; small ints → ::int → Number.
    // Decoded tables are schema-qualified by the lowercased store address;
    // sql(`schema.table`) quotes it as an identifier.
    const [configRows, tourneyRows, duelRows, resultRows, coreRows, statusRows, nameRows] = await Promise.all([
      sql<{ indexedBlock: string }[]>`
        SELECT block_number AS "indexedBlock"
        FROM ${sql(`${mudSchemaName}.config`)}
        LIMIT 1
      `,
      sql`SELECT id::text AS id, players::text AS players, bracket::int AS bracket, status::int AS status FROM ${sql(`${schema}.app__tourney`)}`,
      sql`SELECT id::text AS id, player_a_index::int AS a, player_b_index::int AS b, bracket::int AS bracket, status::int AS status FROM ${sql(`${schema}.app__duel`)}`,
      sql`SELECT id::text AS id, placements::text AS placements, time::int AS time FROM ${sql(`${schema}.app__tourney_result`)}`,
      sql`SELECT id::text AS id, "index"::int AS index, '0x' || encode(owner, 'hex') AS owner FROM ${sql(`${schema}.app__taruchi_core`)}`,
      sql`
        SELECT id::text AS id, affinity::int AS affinity, state::int AS state, level::int AS level,
          xp::int AS xp, training_points::int AS "trainingPoints", bud_index::int AS "budIndex",
          traits::text AS traits, stats::text AS stats
        FROM ${sql(`${schema}.app__taruchi_status`)}
      `,
      sql`SELECT id::text AS id, '0x' || encode(name, 'hex') AS name FROM ${sql(`${schema}.app__taruchi_name`)}`,
    ]);

    const tourneys = tourneyRows.map((r) => ({
      id: BigInt(r.id),
      players: BigInt(r.players),
      bracket: Number(r.bracket),
      status: Number(r.status),
    }));
    const duels = duelRows.map((r) => ({
      id: BigInt(r.id),
      playerAIndex: Number(r.a),
      playerBIndex: Number(r.b),
      bracket: Number(r.bracket),
      status: Number(r.status),
    }));
    const results = resultRows.map((r) => ({
      id: BigInt(r.id),
      placements: BigInt(r.placements),
      time: Number(r.time),
    }));
    const cores = coreRows.map((r) => ({ id: BigInt(r.id), owner: r.owner as string, index: Number(r.index) }));
    const statuses: TaruchiStatusRow[] = statusRows.map((r) => ({
      id: BigInt(r.id),
      state: Number(r.state),
      level: Number(r.level),
      xp: Number(r.xp),
      trainingPoints: Number(r.trainingPoints),
      affinity: Number(r.affinity),
      budIndex: Number(r.budIndex),
      traits: BigInt(r.traits),
      stats: BigInt(r.stats),
    }));
    const names = nameRows.map((r) => ({ id: BigInt(r.id), name: r.name as string }));

    const aggregate = buildAggregate({
      tourneys,
      duels,
      results,
      cores,
      statuses,
      names,
      protocolFeeBps: ONYX_PROTOCOL_FEE_BPS,
      festivalProtocolFeeBps: ONYX_FESTIVAL_PROTOCOL_FEE_BPS,
      jackpotBps: ONYX_TOURNEY_JACKPOT_BPS,
      spriteFor: spriteFor as Parameters<typeof buildAggregate>[0]["spriteFor"],
      decodeName: decodeBytes32Name,
    });

    // Roster-by-owner: every owned taru incl. zero-match (cores drive it, not the
    // played-only leaderboard). Joined to status/name by taruchi id.
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const nameById = new Map(names.map((n) => [n.id, n]));
    const rosterByOwner = new Map<string, TrainerRosterEntry[]>();
    for (const c of cores) {
      const owner = c.owner.toLowerCase();
      const s = statusById.get(c.id);
      const decoded = decodeBytes32Name(nameById.get(c.id)?.name);
      const entry: TrainerRosterEntry = {
        taruchiId: c.id.toString(),
        index: c.index,
        name: decoded || `Taruchi #${c.index}`,
        state: s?.state ?? 0,
        level: s?.level ?? 0,
        affinity: s?.affinity ?? 0,
        imageUrl: traitsImageUrl(s?.traits, opts.cdnBase),
      };
      const list = rosterByOwner.get(owner);
      if (list) list.push(entry);
      else rosterByOwner.set(owner, [entry]);
    }

    // matches-by-owner: every finished duel/festival a wallet's tarus were in,
    // for the Mine archive. Derived from tourneys/duels + results (placements +
    // time) + cores/status/names — no BattleResult needed (the replay loads on
    // click via keyed /api/logs by matchId). One summary object is shared across
    // the participating owners' lists (read-only).
    const coreByIndex = new Map(cores.map((c) => [c.index, c]));
    const resultById = new Map(results.map((r) => [r.id, r]));
    type ParticipantBase = Omit<MatchParticipant, "placement">;
    const participantOf = (idx: number): ParticipantBase | null => {
      const c = coreByIndex.get(idx);
      if (!c) return null;
      const s = statusById.get(c.id);
      const decoded = decodeBytes32Name(nameById.get(c.id)?.name);
      return {
        taruchiId: c.id.toString(),
        index: idx,
        ownerAddress: c.owner.toLowerCase(),
        name: decoded || `Taruchi #${idx}`,
        imageUrl: traitsImageUrl(s?.traits, opts.cdnBase),
      };
    };
    // res.placements is the contract result array (slot positions, NOT 1st..last
    // for festivals): map each position → placement rank via positionToPlacement
    // (same fn buildAggregate uses), attach per participant, and sort by placement
    // so the client gets archive-card-ready data without cross-joining the roster.
    const buildMatch = (
      matchId: bigint,
      type: "duel" | "festival",
      bracket: number,
      res: { placements: bigint; time: number },
    ): MatchSummary => {
      const slots = unpackU32(res.placements);
      const participants = slots
        .map((idx, pos): MatchParticipant | null => {
          if (idx === 0) return null;
          const base = participantOf(idx);
          return base ? { ...base, placement: positionToPlacement(pos, slots.length) } : null;
        })
        .filter((p): p is MatchParticipant => p !== null)
        .sort((a, b) => a.placement - b.placement);
      return { matchId: matchId.toString(), type, bracket, time: res.time, participants };
    };
    const matchesByOwner = new Map<string, MatchSummary[]>();
    const addMatch = (summary: MatchSummary): void => {
      for (const owner of new Set(summary.participants.map((p) => p.ownerAddress))) {
        const list = matchesByOwner.get(owner);
        if (list) list.push(summary);
        else matchesByOwner.set(owner, [summary]);
      }
    };
    for (const tr of tourneys) {
      if (tr.status !== 2) continue; // COMPLETED only
      const res = resultById.get(tr.id);
      if (res) addMatch(buildMatch(tr.id, "festival", tr.bracket, res));
    }
    for (const d of duels) {
      if (d.status !== 2) continue; // COMPLETED only
      const res = resultById.get(d.id);
      if (res) addMatch(buildMatch(d.id, "duel", d.bracket, res));
    }
    for (const list of matchesByOwner.values()) list.sort((a, b) => b.time - a.time);

    // Per-taruchi detail (Fighter Card payload): onchain status + unpacked
    // stats/traits + lifetime record (reused from the aggregate) + per-tier
    // W/L. Same inputs as above; O(tarus + matches), served by /api/taruchi/:id.
    const detailById = buildTaruchiDetails({
      tourneys,
      duels,
      results,
      cores,
      statuses,
      names,
      byTaruchi: aggregate.byTaruchi,
      spriteFor: (_core, status) => traitsImageUrl(status?.traits, opts.cdnBase),
      decodeName: decodeBytes32Name,
    });

    return {
      aggregate,
      rosterByOwner,
      matchesByOwner,
      detailById,
      computedAt: Date.now(),
      indexedBlock: configRows[0]?.indexedBlock ? BigInt(configRows[0].indexedBlock) : null,
    };
  }

  async function commitFreshBuild(startedAt: number): Promise<void> {
    const next = await fetchAndBuild();
    state = next;
    ready = true;
    log.info("aggregate rebuilt", {
      elapsedMs: Date.now() - startedAt,
      indexedBlock: next.indexedBlock?.toString() ?? null,
      wallets: next.aggregate.overall.length,
      tarus: next.aggregate.overallByTaruchi.length,
      owners: next.rosterByOwner.size,
      records: next.aggregate.recordCount,
    });
  }

  async function rebuild(): Promise<void> {
    if (stopped) return;
    if (buildPromise) return buildPromise;
    building = true;
    buildPromise = (async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        await commitFreshBuild(startedAt);
      } catch (e) {
        log.error("aggregate rebuild failed; will retry", { error: e instanceof Error ? e.message : String(e) });
        if (!stopped) {
          // fallback retry, independent of the block-driven debounce
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(() => {
            pendingTimer = undefined;
            void rebuild();
          }, retryMs);
        }
      } finally {
        building = false;
        buildPromise = undefined;
      }
    })();
    return buildPromise;
  }

  async function rebuildNow(): Promise<void> {
    if (stopped) return;
    if (forcedBuildPromise) return forcedBuildPromise;
    if (buildPromise) await buildPromise;
    if (stopped) return;
    if (forcedBuildPromise) return forcedBuildPromise;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }

    building = true;
    buildPromise = (async (): Promise<void> => {
      try {
        await commitFreshBuild(Date.now());
      } finally {
        building = false;
        buildPromise = undefined;
        forcedBuildPromise = undefined;
      }
    })();
    forcedBuildPromise = buildPromise;
    return forcedBuildPromise;
  }

  // Coalesce block-driven rebuilds to at most one per debounce window.
  function scheduleRebuild(): void {
    if (pendingTimer || building || stopped) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void rebuild();
    }, debounceMs);
  }

  return {
    isReady: () => ready,
    getAggregate: () => state.aggregate,
    getStats: (wallet) => state.aggregate.byWallet.get(wallet.toLowerCase()) ?? null,
    getRoster: (wallet) => state.rosterByOwner.get(wallet.toLowerCase()) ?? [],
    getBattles: (wallet) => state.matchesByOwner.get(wallet.toLowerCase()) ?? [],
    getTaruchi: (id) => state.detailById.get(id) ?? null,
    computedAt: () => state.computedAt,
    indexedBlock: () => state.indexedBlock,
    rebuildNow,
    start: (block$): void => {
      void rebuild(); // immediate build on startup
      sub = block$.subscribe({
        next: () => scheduleRebuild(),
        error: (err) => log.error("block stream error", { error: err instanceof Error ? err.message : String(err) }),
      });
    },
    stop: (): void => {
      stopped = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      sub?.unsubscribe();
    },
  };
}
