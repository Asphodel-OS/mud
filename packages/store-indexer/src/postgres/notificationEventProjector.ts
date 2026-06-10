import { resourceToHex } from "@latticexyz/common";
import { type SupabaseClient } from "@supabase/supabase-js";
import { type Hex, hexToBigInt, sliceHex } from "viem";
import { StorageAdapterLog } from "@latticexyz/store-sync";
import { logger } from "../logger";
import {
  type Projector,
  type ProjectorContext,
  type SetRecord,
  keyToId,
  readStaticUint,
  setRecordsFor,
} from "./supabasePush";

const log = logger.child({ component: "notification-event" });

/**
 * notificationEventProjector — writes `notification_events` rows when a player's
 * onchain thing RESOLVES (mint reveal, duel complete, festival complete). A
 * Supabase DB webhook on insert fans each row out via the send-push edge fn.
 *
 * Captured straight from `block.logs` (same posture as the SQS reveal hook +
 * tourneyAnnouncementProjector) — never a DB read. Two things shape the design:
 *
 *  1. Signals are taruchi INDICES or IDs, never wallets, and resolving rows
 *     carry no owner — so we keep owner caches learned from TaruchiCore writes
 *     (ownerById for mint, ownerByIndex for duel/festival players).
 *
 *  2. We only watch full `Store_SetRecord` events (setRecordsFor). That dictates
 *     WHICH write we key off for each event — verified against the contracts:
 *       - MINT: reveal does `TaruchiStatus.set(IDLE)` — the FIRST Status write
 *         for that id (mint commit writes no Status row; UNREVEALED=0 is just the
 *         unwritten default). So mint = first IDLE Status write (prev undefined).
 *         Training/duel returns to IDLE are on an already-seen id (prev defined),
 *         so they don't false-fire. Reroll gets a new id → first write → fires.
 *       - DUEL + FESTIVAL: both resolve by writing `TourneyResult.set(...)` (a
 *         full SetRecord). We do NOT watch Duel.status — `Duel.setStatus` emits a
 *         Store_SpliceStaticData, which setRecordsFor (rightly) ignores. The
 *         duel's player indices come from the Duel.set ENROLL SetRecord (cached);
 *         the festival's entrants from the Tourney.set enroll SetRecord (cached).
 *         At the TourneyResult write we branch: a known duel id → duel, else a
 *         festival-bracket Tourney id → festival.
 *
 * Training delivery is deferred (the toggle ships, no send) — see the PRD.
 */

// --- enums (codegen common.sol) ---
const STATE_IDLE = 1; // TaruchiState.IDLE
const FESTIVAL_BRACKETS = new Set([4, 5, 6]); // ROOKIE/VETERAN/CHAMPION_FESTIVAL

// --- table ids ---
const TARUCHI_CORE_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "TaruchiCore" });
const TARUCHI_STATUS_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "TaruchiStatus" });
const DUEL_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Duel" });
const TOURNEY_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Tourney" });
const TOURNEY_RESULT_TABLE_ID = resourceToHex({ type: "offchainTable", namespace: "app", name: "TourneyResult" });

// --- static field offsets (verified against the codegen decodeStatic) ---
// TaruchiCore : owner address @0 (20), index u32 @20 (4)
const CORE_OWNER_OFFSET = 0;
const CORE_INDEX_OFFSET = 20;
// TaruchiStatus: affinity u8 @0, state u8 @1, ...
const STATUS_STATE_OFFSET = 1;
// Duel : playerAIndex u32 @0, playerBIndex u32 @4, bracket u8 @8, status u8 @9
const DUEL_A_OFFSET = 0;
const DUEL_B_OFFSET = 4;
// Tourney : players u256 @0, specs u256 @32, bracket u8 @64, status u8 @65
const TOURNEY_PLAYERS_OFFSET = 0;
const TOURNEY_BRACKET_OFFSET = 64;

/** Read a fixed-length address field as a lowercase 0x-hex string. */
function readAddress(staticData: Hex, offset: number): string {
  return sliceHex(staticData, offset, offset + 20).toLowerCase();
}

/** Unpack a packed uint32[8] (e.g. Tourney.players) into its non-zero indices. */
export function unpackIndices(packed: bigint): number[] {
  const out: number[] = [];
  let p = packed;
  for (let i = 0; i < 8; i++) {
    const v = Number(p & 0xffffffffn);
    if (v !== 0) out.push(v);
    p >>= 32n;
  }
  return out;
}

/** Mutable cross-block caches. Owner maps learned from TaruchiCore; enroll maps
 *  from Duel/Tourney SetRecords; lastStateById marks ids we've already seen a
 *  Status write for (so the first IDLE = mint reveal). Never pruned (a reorg may
 *  replay only the resolve block; the enroll/mint precedes it). */
export type NotifCaches = {
  ownerById: Map<string, string>;
  ownerByIndex: Map<number, string>;
  lastStateById: Map<string, number>;
  duelPlayersById: Map<string, [number, number]>;
  playersById: Map<string, bigint>;
  bracketById: Map<string, number>;
  /** Highest block processed — used to detect a reorg replay (block regresses).
   *  The indexer recovers from ReorgError in-process (no restart), so caches
   *  persist; without this, lastStateById would silence a legit re-revealed
   *  mint after a reorg. -1 = nothing processed yet. */
  highWaterBlock: number;
};

export function emptyCaches(): NotifCaches {
  return {
    ownerById: new Map(),
    ownerByIndex: new Map(),
    lastStateById: new Map(),
    duelPlayersById: new Map(),
    playersById: new Map(),
    bracketById: new Map(),
    highWaterBlock: -1,
  };
}

export type NotifEvent = {
  type: "mint" | "duel" | "festival";
  recipient_wallet: string; // lowercase
  taruchi_id: string; // the taru/duel/tourney id this event is about
};

/**
 * Pure: decode the notifiable resolutions in this block, mutating `caches`.
 * Side-effect-free w.r.t. Supabase, so it's unit-testable. Caller decides
 * whether to actually publish (isCaughtUp gate).
 */
export function extractNotifEvents(
  logs: readonly StorageAdapterLog[],
  caches: NotifCaches,
  blockNumber: number,
): NotifEvent[] {
  // 0) Reorg detection. The indexer recovers from ReorgError in-process and
  //    re-processes from the common ancestor, so blockNumber regresses. Clear
  //    the mint-seen gate so a reveal in the replayed range can re-fire — the
  //    notification_events dedup (same block) absorbs a same-block replay, and
  //    a genuinely re-mined reveal re-notifying once beats permanent silence.
  //    Owner/enroll caches are learned facts (taught before the boundary) — keep
  //    them so replayed resolves can still resolve recipients.
  if (blockNumber < caches.highWaterBlock) {
    log.info("reorg replay detected — clearing mint-seen gate", { blockNumber, from: caches.highWaterBlock });
    caches.lastStateById.clear();
  }
  caches.highWaterBlock = Math.max(caches.highWaterBlock, blockNumber);

  // 1) Learn owners (TaruchiCore is written at mint/reroll, before any resolve).
  for (const rec of setRecordsFor(logs, TARUCHI_CORE_TABLE_ID)) {
    const id = keyToId(rec);
    const owner = readAddress(rec.staticData, CORE_OWNER_OFFSET);
    const index = readStaticUint(rec.staticData, CORE_INDEX_OFFSET, 4);
    caches.ownerById.set(id, owner);
    if (index !== 0) caches.ownerByIndex.set(index, owner);
  }
  // Learn duel player indices from the enroll SetRecord (resolve is a splice we
  // don't see — we trigger off the TourneyResult write instead).
  for (const rec of setRecordsFor(logs, DUEL_TABLE_ID)) {
    caches.duelPlayersById.set(keyToId(rec), [
      readStaticUint(rec.staticData, DUEL_A_OFFSET, 4),
      readStaticUint(rec.staticData, DUEL_B_OFFSET, 4),
    ]);
  }
  // Learn festival bracket + entrants from the Tourney enroll SetRecord.
  for (const rec of setRecordsFor(logs, TOURNEY_TABLE_ID)) {
    const id = keyToId(rec);
    caches.bracketById.set(id, readStaticUint(rec.staticData, TOURNEY_BRACKET_OFFSET, 1));
    caches.playersById.set(
      id,
      hexToBigInt(sliceHex(rec.staticData, TOURNEY_PLAYERS_OFFSET, TOURNEY_PLAYERS_OFFSET + 32)),
    );
  }

  const events: NotifEvent[] = [];
  const warnMiss = (what: string, key: string | number): void => {
    log.warn("owner not in cache; skipping notification", { what, key, block: blockNumber });
  };

  // 2) MINT — reveal is the FIRST TaruchiStatus write (prev undefined) landing
  //    IDLE. Already-seen ids returning to IDLE (training/duel) don't fire.
  for (const rec of setRecordsFor(logs, TARUCHI_STATUS_TABLE_ID)) {
    const id = keyToId(rec);
    const state = readStaticUint(rec.staticData, STATUS_STATE_OFFSET, 1);
    const firstWrite = !caches.lastStateById.has(id);
    caches.lastStateById.set(id, state);
    if (firstWrite && state === STATE_IDLE) {
      const owner = caches.ownerById.get(id);
      if (!owner) {
        warnMiss("mint", id);
        continue;
      }
      events.push({ type: "mint", recipient_wallet: owner, taruchi_id: id });
    }
  }

  // 3) DUEL + FESTIVAL — both resolve by writing TourneyResult. Branch on the id:
  //    a known duel → both players; else a festival-bracket tourney → all entrants.
  for (const rec of setRecordsFor(logs, TOURNEY_RESULT_TABLE_ID)) {
    const id = keyToId(rec);
    const duel = caches.duelPlayersById.get(id);
    if (duel) {
      for (const idx of duel) {
        if (idx === 0) continue;
        const owner = caches.ownerByIndex.get(idx);
        if (!owner) {
          warnMiss("duel", idx);
          continue;
        }
        events.push({ type: "duel", recipient_wallet: owner, taruchi_id: id });
      }
      continue;
    }
    const bracket = caches.bracketById.get(id);
    if (bracket === undefined) {
      // Neither a known duel nor a known tourney — enroll write never seen
      // (indexer started after it). Surfaced so missed notifications aren't
      // invisible (mirrors tourneyAnnouncementProjector's warn).
      warnMiss("result-unknown-id", id);
      continue;
    }
    if (!FESTIVAL_BRACKETS.has(bracket)) continue; // known non-festival tourney — intentional skip
    const packed = caches.playersById.get(id);
    if (packed === undefined) {
      warnMiss("festival", id);
      continue;
    }
    for (const idx of unpackIndices(packed)) {
      const owner = caches.ownerByIndex.get(idx);
      if (!owner) {
        warnMiss("festival-player", idx);
        continue;
      }
      events.push({ type: "festival", recipient_wallet: owner, taruchi_id: id });
    }
  }

  return events;
}

/** Per-type push copy. send-push has fallbacks, but we set real CTAs here. */
function payloadFor(type: NotifEvent["type"]): { title: string; body: string; url: string } {
  switch (type) {
    case "mint":
      return { title: "Your Taruchi is ready", body: "Your mint revealed — come meet your fighter.", url: "/" };
    case "duel":
      return { title: "Duel resolved", body: "Your duel is finished — see how it went.", url: "/arena" };
    case "festival":
      return { title: "Festival finished", body: "The festival has concluded — check your placement.", url: "/arena" };
  }
}

/**
 * Insert notification_events. Idempotent via the table's UNIQUE
 * (type, recipient_wallet, taruchi_id, block_number) dedup constraint —
 * onConflict ignore makes same-block reorg replays no-op. (A resolve reorged to
 * a DIFFERENT block AND the indexer restarting in between is the one
 * double-notify window; one-shot events make it benign. The constraint columns
 * live in the prologue-supabase migration — keep this onConflict in lockstep.)
 */
async function publish(supabase: SupabaseClient, events: NotifEvent[], blockNumber: number): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map((e) => ({
    recipient_wallet: e.recipient_wallet,
    type: e.type,
    taruchi_id: e.taruchi_id,
    block_number: blockNumber,
    payload: payloadFor(e.type),
  }));
  const { error } = await supabase
    .from("notification_events")
    .upsert(rows, { onConflict: "type,recipient_wallet,taruchi_id,block_number", ignoreDuplicates: true });
  if (error) throw new Error(`insert notification_events failed: ${error.message}`);
  return rows.length;
}

export function createNotificationEventProjector(): Projector {
  const caches = emptyCaches();
  return {
    name: "notification-event",
    onBlock: async (logs: readonly StorageAdapterLog[], ctx: ProjectorContext): Promise<void> => {
      // Always update caches (we need prior-seen + enroll info across blocks),
      // but only publish once caught up so backfill doesn't blast old players.
      const events = extractNotifEvents(logs, caches, ctx.blockNumber);
      if (events.length === 0 || !ctx.isCaughtUp()) return;
      // `attempted` not `inserted`: the upsert uses ignoreDuplicates, which
      // returns no count, so dedup'd rows (e.g. same-block reorg replay) are
      // omitted silently — we can only report what we sent, not what landed.
      const attempted = await publish(ctx.supabase, events, ctx.blockNumber);
      log.info("published", { attempted, block: ctx.blockNumber });
    },
  };
}

// re-export so the test file can use the narrowed SetRecord shape if needed
export type { SetRecord };
