import { Sql } from "postgres";
import { Observable, Subscription } from "rxjs";
import { hexToString, type Hex } from "viem";
import { buildAggregate } from "../leaderboard/buildAggregate";
import {
  ONYX_PROTOCOL_FEE_BPS,
  ONYX_FESTIVAL_PROTOCOL_FEE_BPS,
  ONYX_TOURNEY_JACKPOT_BPS,
} from "../leaderboard/onyxConstants";
import { EMPTY_AGGREGATE, type LeaderboardAggregate, type LeaderboardRow } from "../leaderboard/types";
import { logger } from "../logger";

const log = logger.child({ component: "leaderboard-cache" });

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

export interface LeaderboardCache {
  isReady(): boolean;
  /** Empty aggregate until the first build succeeds. */
  getAggregate(): LeaderboardAggregate;
  /** Stats row for a wallet (lowercased), or null. */
  getStats(wallet: string): LeaderboardRow | null;
  /** All tarus owned by a wallet (lowercased), incl. zero-match. */
  getRoster(wallet: string): TrainerRosterEntry[];
  computedAt(): number;
  /** Wire a recompute to a block stream (debounced) + kick the first build. */
  start(block$: Observable<unknown>): void;
  stop(): void;
}

type CacheState = {
  aggregate: LeaderboardAggregate;
  rosterByOwner: Map<string, TrainerRosterEntry[]>;
  computedAt: number;
};

const EMPTY_STATE: CacheState = { aggregate: EMPTY_AGGREGATE, rosterByOwner: new Map(), computedAt: 0 };

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
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let sub: Subscription | undefined;
  let stopped = false;

  async function fetchAndBuild(): Promise<CacheState> {
    // uint256/uint40 packed fields → ::text then BigInt; small ints → ::int → Number.
    // Decoded tables are schema-qualified by the lowercased store address;
    // sql(`schema.table`) quotes it as an identifier.
    const [tourneyRows, duelRows, resultRows, coreRows, statusRows, nameRows] = await Promise.all([
      sql`SELECT id::text AS id, players::text AS players, bracket::int AS bracket, status::int AS status FROM ${sql(`${schema}.app__tourney`)}`,
      sql`SELECT id::text AS id, player_a_index::int AS a, player_b_index::int AS b, bracket::int AS bracket, status::int AS status FROM ${sql(`${schema}.app__duel`)}`,
      sql`SELECT id::text AS id, placements::text AS placements FROM ${sql(`${schema}.app__tourney_result`)}`,
      sql`SELECT id::text AS id, "index"::int AS index, '0x' || encode(owner, 'hex') AS owner FROM ${sql(`${schema}.app__taruchi_core`)}`,
      sql`SELECT id::text AS id, affinity::int AS affinity, state::int AS state, level::int AS level, traits::text AS traits FROM ${sql(`${schema}.app__taruchi_status`)}`,
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
    const results = resultRows.map((r) => ({ id: BigInt(r.id), placements: BigInt(r.placements) }));
    const cores = coreRows.map((r) => ({ id: BigInt(r.id), owner: r.owner as string, index: Number(r.index) }));
    const statuses = statusRows.map((r) => ({
      id: BigInt(r.id),
      state: Number(r.state),
      level: Number(r.level),
      affinity: Number(r.affinity),
      traits: BigInt(r.traits),
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

    return { aggregate, rosterByOwner, computedAt: Date.now() };
  }

  async function rebuild(): Promise<void> {
    if (building || stopped) return;
    building = true;
    const startedAt = Date.now();
    try {
      const next = await fetchAndBuild();
      state = next;
      ready = true;
      log.info("aggregate rebuilt", {
        elapsedMs: Date.now() - startedAt,
        wallets: next.aggregate.overall.length,
        tarus: next.aggregate.overallByTaruchi.length,
        owners: next.rosterByOwner.size,
        records: next.aggregate.recordCount,
      });
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
    }
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
    computedAt: () => state.computedAt,
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
