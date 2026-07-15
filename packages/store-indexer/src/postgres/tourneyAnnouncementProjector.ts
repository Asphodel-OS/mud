import { resourceToHex } from "@latticexyz/common";
import { type SupabaseClient } from "@supabase/supabase-js";
import { StorageAdapterLog } from "@latticexyz/store-sync";
import { logger } from "../logger";
import { type Projector, type ProjectorContext, keyToId, readStaticUint, setRecordsFor } from "./supabasePush";

const log = logger.child({ component: "tourney-announcement" });

/**
 * Festival bracket enum → display name. Mirrors game2's
 * `screens/arena/config.ts` BRACKETS (festival entries) and the on-chain
 * `Bracket` enum (NULL=0, ROOKIE=1, VETERAN=2, CHAMPION=3, ROOKIE_FESTIVAL=4,
 * VETERAN_FESTIVAL=5, CHAMPION_FESTIVAL=6). mud has no name column, so the
 * projector maps here. Keep in sync with game2 if the festival names change.
 */
export const FESTIVAL_NAMES: Record<number, string> = {
  4: "Festival of Buds",
  5: "Festival of Flowers",
  6: "Ascension Festival",
};

/** The single pre-formatted line stored in `announcements.message`. */
export function formatAnnouncement(name: string): string {
  return `${name} has just finished.`;
}

export type FinishedTournament = {
  tournament_id: string;
  name: string;
  finished_at: string; // ISO 8601
};

/**
 * Tournaments not yet mirrored in Supabase — the exactly-once gate for
 * announcements. Because `tournament_results` persists, a replay (reorg or
 * restart) sees the id as existing and emits no duplicate announcement.
 */
export function newAnnouncements(finished: FinishedTournament[], existingIds: Set<string>): FinishedTournament[] {
  return finished.filter((t) => !existingIds.has(t.tournament_id));
}

// --- on-chain table ids (captured straight from block.logs, no DB read) ---
// `Tourney` is an onchain table; `TourneyResult` is an OFFCHAIN table — it
// still emits `Store_SetRecord` events, just with the "ot" resource prefix
// instead of "tb". Getting this type wrong yields a tableId that never matches.
const TOURNEY_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Tourney" });
const TOURNEY_RESULT_TABLE_ID = resourceToHex({ type: "offchainTable", namespace: "app", name: "TourneyResult" });
// Duels resolve by writing TourneyResult too (LibDuel.finishDuel), sharing its
// key space. A duel's bracket lives in the onchain Duel table and is always
// non-festival (LibDuel.verifyDuelBracketLevel reverts festival/NULL), so
// identity alone is enough to filter duel results — never decode Duel
// staticData here. Same posture as notificationEventProjector's duel branch.
const DUEL_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Duel" });

// --- static field layouts (from the codegen valueSchemas) ---
// Tourney value: (players u256 @0, specs u192 @32, bracket u8 @56, status u8 @57)
// (specs shrank u256→u192 in the gas-opt B3 change → bracket/status moved -8 bytes)
const TOURNEY_BRACKET_OFFSET = 56;
// TourneyResult value: (placements u256 @0, time u32 @32)
const TOURNEY_RESULT_TIME_OFFSET = 32;

/**
 * Decode the festivals finished in this block straight from the chain logs:
 *  - Each `Tourney` SetRecord (written at enroll) carries the bracket — cache
 *    it by id, because the result write below has no bracket of its own.
 *  - Each `TourneyResult` SetRecord (written at resolve) gives id (key) + time
 *    (static field). Look up the bracket; if it's a festival, emit it.
 *
 * `bracketById` and `knownDuelIds` persist across blocks (enroll precedes
 * resolve) and are mutated here. Pure & side-effect-free w.r.t. Supabase, so
 * it's unit-testable.
 */
export function extractFinishedFestivals(
  logs: readonly StorageAdapterLog[],
  bracketById: Map<string, number>,
  knownDuelIds: Set<string>,
  blockNumber: number,
): FinishedTournament[] {
  // 1) learn brackets from Tourney enroll writes, and duel ids from Duel enroll
  //    writes (the only Duel SetRecord — resolve is a status splice we don't see)
  for (const rec of setRecordsFor(logs, TOURNEY_TABLE_ID)) {
    bracketById.set(keyToId(rec), readStaticUint(rec.staticData, TOURNEY_BRACKET_OFFSET, 1));
  }
  for (const rec of setRecordsFor(logs, DUEL_TABLE_ID)) {
    knownDuelIds.add(keyToId(rec));
  }

  // 2) emit for festivals whose result was just written
  const finished: FinishedTournament[] = [];
  for (const rec of setRecordsFor(logs, TOURNEY_RESULT_TABLE_ID)) {
    const id = keyToId(rec);
    // A known duel resolving: nothing to announce. Consume the id (self-prune
    // keeps the Set bounded to in-flight duels at ~1 duel resolve per block)
    // and skip before the bracket lookup so the warn below stays a genuine
    // anomaly signal instead of firing per duel.
    if (knownDuelIds.delete(id)) continue;
    const bracket = bracketById.get(id);
    if (bracket === undefined) {
      // Festival enroll write not seen (indexer started after it) — can't name
      // it. Duel results are filtered above. With START_BLOCK at the world
      // deploy this never happens.
      log.warn("tourney result with no known bracket; skipping", { id, block: blockNumber });
      continue;
    }
    const name = FESTIVAL_NAMES[bracket];
    if (name === undefined) continue; // duel / non-festival bracket
    const time = readStaticUint(rec.staticData, TOURNEY_RESULT_TIME_OFFSET, 4);
    finished.push({ tournament_id: id, name, finished_at: new Date(time * 1000).toISOString() });
  }
  return finished;
}

/**
 * The write half: upsert `tournament_results` (durable record, always) and —
 * for live finishes only — insert `announcements` for the genuinely-new ones.
 * Throws on a Supabase error (the funnel isolates it).
 */
async function publishToSupabase(
  supabase: SupabaseClient,
  finished: FinishedTournament[],
  currentBlock: number,
  announce: boolean,
): Promise<{ mirrored: number; announced: number }> {
  if (finished.length === 0) return { mirrored: 0, announced: 0 };

  // Which tournaments are already mirrored? Computed BEFORE the upsert so a
  // freshly-mirrored row isn't mistaken for pre-existing (→ no dup announce).
  // Scoped to the current batch (.in) so this never hits PostgREST's default
  // 1000-row select cap, which would otherwise re-announce old festivals.
  const { data: existingRows, error: selErr } = await supabase
    .from("tournament_results")
    .select("tournament_id")
    .in(
      "tournament_id",
      finished.map((t) => t.tournament_id),
    );
  if (selErr) {
    throw new Error(`read existing tournament_results failed: ${selErr.message}`);
  }
  const existingIds = new Set((existingRows ?? []).map((r) => String(r.tournament_id)));

  // Mirror all finished festivals (idempotent by primary key).
  const { error: upsertErr } = await supabase.from("tournament_results").upsert(
    finished.map((t) => ({ ...t, block_number: currentBlock })),
    { onConflict: "tournament_id" },
  );
  if (upsertErr) {
    throw new Error(`upsert tournament_results failed: ${upsertErr.message}`);
  }

  // One announcement per genuinely-new tournament — only for live finishes.
  let announced = 0;
  if (announce) {
    const fresh = newAnnouncements(finished, existingIds);
    if (fresh.length > 0) {
      const { error: annErr } = await supabase
        .from("announcements")
        .insert(fresh.map((t) => ({ message: formatAnnouncement(t.name) })));
      if (annErr) {
        throw new Error(`insert announcements failed: ${annErr.message}`);
      }
      announced = fresh.length;
    }
  }

  return { mirrored: finished.length, announced };
}

/**
 * createTourneyAnnouncementProjector — captures finished festivals straight from
 * the chain (the same posture as the SQS reveal hook reading TaruchiStatus),
 * never by polling the DB. Mirrors `tournament_results` always; announces only
 * once the indexer has caught up so historical backfill doesn't spam chat.
 */
export function createTourneyAnnouncementProjector(seed?: {
  bracketById?: Map<string, number>;
  knownDuelIds?: Set<string>;
}): Projector {
  // id → bracket, learned from Tourney enroll writes. Persisted across blocks
  // (enroll precedes resolve) and never pruned: a reorg may replay only the
  // resolve block, so we must keep brackets for already-enrolled tourneys.
  // Copied (not aliased) from the optional seed so the caller's map stays
  // independently mutable after construction.
  const bracketById = new Map(seed?.bracketById);
  // Duel ids learned from Duel enroll writes, consumed when their TourneyResult
  // lands. Deliberately the opposite retention to bracketById (and to the
  // sibling's never-pruned duelPlayersById): duels emit no announcement, so a
  // resolved duel's id is dead weight, and a reorg replaying a pruned duel
  // resolve costs at most one warn before skipping correctly. A seeded id may
  // already be resolved on-chain (bounded, same never-pruned posture as the
  // sibling's duelPlayersById until its result is next seen). Copied from the
  // optional seed for the same independence reason as bracketById.
  const knownDuelIds = new Set(seed?.knownDuelIds);

  return {
    name: "tourney-announcement",
    onBlock: async (logs: readonly StorageAdapterLog[], ctx: ProjectorContext): Promise<void> => {
      const finished = extractFinishedFestivals(logs, bracketById, knownDuelIds, ctx.blockNumber);
      if (finished.length === 0) return;

      const announce = ctx.isCaughtUp();
      const { mirrored, announced } = await publishToSupabase(ctx.supabase, finished, ctx.blockNumber, announce);
      log.info("published", { mirrored, announced, block: ctx.blockNumber, caughtUp: announce });
    },
  };
}
