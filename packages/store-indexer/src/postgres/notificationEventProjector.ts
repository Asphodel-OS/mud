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
// TaruchiCore : index u32 @0 (4), owner address @4 (20) — `index` was moved ahead of `owner`
const CORE_INDEX_OFFSET = 0;
const CORE_OWNER_OFFSET = 4;
// TaruchiStatus: affinity u8 @0, state u8 @1, ...
const STATUS_STATE_OFFSET = 1;
// Duel : playerAIndex u32 @0, playerBIndex u32 @4, bracket u8 @8, status u8 @9
const DUEL_A_OFFSET = 0;
const DUEL_B_OFFSET = 4;
// Tourney : players u256 @0, specs u192 @32, bracket u8 @56, status u8 @57
// (specs shrank u256→u192 in the gas-opt B3 change → bracket/status moved -8 bytes)
const TOURNEY_PLAYERS_OFFSET = 0;
const TOURNEY_BRACKET_OFFSET = 56;

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
  /** The previous block processed — used to detect a reorg replay (block
   *  regresses below it exactly once, at the boundary). NOT a high-water max:
   *  tracking the last block means subsequent replayed blocks climb forward and
   *  don't re-trigger the gate clear. The indexer recovers from ReorgError
   *  in-process (no restart), so caches persist; without this, lastStateById
   *  would silence a legit re-revealed mint after a reorg. -1 = none yet. */
  lastBlock: number;
};

export function emptyCaches(): NotifCaches {
  return {
    ownerById: new Map(),
    ownerByIndex: new Map(),
    lastStateById: new Map(),
    duelPlayersById: new Map(),
    playersById: new Map(),
    bracketById: new Map(),
    lastBlock: -1,
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
  //    re-processes from the common ancestor, so blockNumber regresses ONCE at
  //    the boundary, then climbs again. Clear the mint-seen gate exactly at that
  //    boundary so a reveal in the replayed range can re-fire — but track the
  //    PREVIOUS block (not a high-water max), or every replayed block would stay
  //    below the peak and re-clear the gate on each one, wiping prior-state
  //    accumulated during the replay (→ false mints once caught up). Owner/enroll
  //    caches are learned facts (taught before the boundary) — kept either way.
  if (blockNumber < caches.lastBlock) {
    log.info("reorg replay detected — clearing mint-seen gate", { blockNumber, from: caches.lastBlock });
    caches.lastStateById.clear();
  }
  caches.lastBlock = blockNumber;

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

// No type_training: the projector never emits training events (delivery deferred).
type SubRow = { wallet: string; type_mint: boolean; type_duel: boolean; type_festival: boolean };

/**
 * Drop events whose recipient isn't subscribed for that type — the opt-in gate,
 * at the source. One batched read per block (`wallet IN (…)`), the producer's
 * only DB read.
 *
 * Without it every resolution writes a row for every player, each firing the DB
 * webhook → a send-push that finds nothing: cost scales with DAU, not opt-in,
 * and the per-row pg_net queue backs up first. send-push re-checks at delivery
 * regardless (closes the unsubscribe-after-write race), so this only trims the
 * upstream no-op fan-out.
 *
 * Fail-closed: a read error throws (the adapter logs + isolates it), skipping a
 * block's notifications rather than blasting them. Cold start: a wallet that
 * subscribes after its event's block is processed misses it once — benign for
 * one-shot events.
 */
export async function filterToSubscribed(supabase: SupabaseClient, events: NotifEvent[]): Promise<NotifEvent[]> {
  if (events.length === 0) return events;
  const wallets = [...new Set(events.map((e) => e.recipient_wallet))];
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("wallet, type_mint, type_duel, type_festival")
    .in("wallet", wallets);
  if (error) throw new Error(`read push_subscriptions failed: ${error.message}`);

  // wallet → enabled types, unioned across its device rows.
  const enabled = new Map<string, Set<NotifEvent["type"]>>();
  for (const row of (data ?? []) as SubRow[]) {
    let set = enabled.get(row.wallet);
    if (!set) enabled.set(row.wallet, (set = new Set()));
    if (row.type_mint) set.add("mint");
    if (row.type_duel) set.add("duel");
    if (row.type_festival) set.add("festival");
  }
  return events.filter((e) => enabled.get(e.recipient_wallet)?.has(e.type));
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
      // Opt-in gate at the source: no row / webhook / send-push for non-subscribers.
      const deliverable = await filterToSubscribed(ctx.supabase, events);
      if (deliverable.length === 0) return;
      // `attempted` not `inserted`: the upsert uses ignoreDuplicates, which
      // returns no count, so dedup'd rows (e.g. same-block reorg replay) are
      // omitted silently — we can only report what we sent, not what landed.
      const attempted = await publish(ctx.supabase, deliverable, ctx.blockNumber);
      log.info("published", { attempted, candidates: events.length, block: ctx.blockNumber });
    },
  };
}

// re-export so the test file can use the narrowed SetRecord shape if needed
export type { SetRecord };
