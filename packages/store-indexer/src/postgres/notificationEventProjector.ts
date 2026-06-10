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
 * Everything is captured straight from `block.logs` (same posture as the SQS
 * reveal hook + tourneyAnnouncementProjector) — never a DB read. The one wrinkle
 * the other projectors don't have: every onchain signal is a taruchi INDEX or a
 * taruchi ID, never a wallet, and the resolving table rows carry no owner. So we
 * maintain owner caches learned from TaruchiCore writes (which carry both id and
 * index → owner). See the architect note in docs/PUSH_NOTIFICATIONS_BUILD_PLAN.
 *
 * Training is intentionally NOT emitted: a TaruchiStatus→IDLE write is
 * indistinguishable mint-vs-training from the new state alone, so we only emit
 * `mint` on the specific UNREVEALED→IDLE transition (tracked via lastStateById).
 */

// --- enums (codegen common.sol) ---
const STATE_UNREVEALED = 0;
const STATE_IDLE = 1;
const TOURNEY_STATE_COMPLETED = 2;
const FESTIVAL_BRACKETS = new Set([4, 5, 6]); // ROOKIE/VETERAN/CHAMPION_FESTIVAL

// --- table ids ---
const TARUCHI_CORE_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "TaruchiCore" });
const TARUCHI_STATUS_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "TaruchiStatus" });
const DUEL_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Duel" });
const TOURNEY_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Tourney" });
const TOURNEY_RESULT_TABLE_ID = resourceToHex({ type: "offchainTable", namespace: "app", name: "TourneyResult" });

// --- static field offsets (from the codegen valueSchemas) ---
// TaruchiCore  : owner address @0 (20), index u32 @20 (4)
const CORE_OWNER_OFFSET = 0;
const CORE_INDEX_OFFSET = 20;
// TaruchiStatus: affinity u8 @0, state u8 @1, ...
const STATUS_STATE_OFFSET = 1;
// Duel         : playerAIndex u32 @0, playerBIndex u32 @4, bracket u8 @8, status u8 @9
const DUEL_A_OFFSET = 0;
const DUEL_B_OFFSET = 4;
const DUEL_STATUS_OFFSET = 9;
// Tourney      : players u256 @0, specs u256 @32, bracket u8 @64, status u8 @65
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

/** Mutable cross-block caches. Owner maps are learned from TaruchiCore; state
 *  maps track prior values so we fire on transitions, not on every rewrite. */
export type NotifCaches = {
  ownerById: Map<string, string>;
  ownerByIndex: Map<number, string>;
  lastStateById: Map<string, number>;
  lastDuelStatus: Map<string, number>;
  playersById: Map<string, bigint>;
  bracketById: Map<string, number>;
};

export function emptyCaches(): NotifCaches {
  return {
    ownerById: new Map(),
    ownerByIndex: new Map(),
    lastStateById: new Map(),
    lastDuelStatus: new Map(),
    playersById: new Map(),
    bracketById: new Map(),
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
  // 1) Learn owners FIRST (a mint's Core write may share this block with later
  //    logic; enroll Core writes precede duel/festival resolves anyway).
  for (const rec of setRecordsFor(logs, TARUCHI_CORE_TABLE_ID)) {
    const id = keyToId(rec);
    const owner = readAddress(rec.staticData, CORE_OWNER_OFFSET);
    const index = readStaticUint(rec.staticData, CORE_INDEX_OFFSET, 4);
    caches.ownerById.set(id, owner);
    if (index !== 0) caches.ownerByIndex.set(index, owner);
  }
  // Learn tourney bracket + players (enroll precedes resolve; never pruned).
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

  // 2) MINT — only the UNREVEALED→IDLE transition (training/duel returns also
  //    land IDLE; the prior-state guard is what isolates a genuine mint reveal).
  for (const rec of setRecordsFor(logs, TARUCHI_STATUS_TABLE_ID)) {
    const id = keyToId(rec);
    const state = readStaticUint(rec.staticData, STATUS_STATE_OFFSET, 1);
    const prev = caches.lastStateById.get(id);
    caches.lastStateById.set(id, state);
    if (state === STATE_IDLE && prev === STATE_UNREVEALED) {
      const owner = caches.ownerById.get(id);
      if (!owner) {
        warnMiss("mint", id);
        continue;
      }
      events.push({ type: "mint", recipient_wallet: owner, taruchi_id: id });
    }
  }

  // 3) DUEL — fire once on the transition into COMPLETED, for both players.
  for (const rec of setRecordsFor(logs, DUEL_TABLE_ID)) {
    const id = keyToId(rec);
    const status = readStaticUint(rec.staticData, DUEL_STATUS_OFFSET, 1);
    const prev = caches.lastDuelStatus.get(id);
    caches.lastDuelStatus.set(id, status);
    if (status === TOURNEY_STATE_COMPLETED && prev !== TOURNEY_STATE_COMPLETED) {
      const aIdx = readStaticUint(rec.staticData, DUEL_A_OFFSET, 4);
      const bIdx = readStaticUint(rec.staticData, DUEL_B_OFFSET, 4);
      for (const idx of [aIdx, bIdx]) {
        if (idx === 0) continue;
        const owner = caches.ownerByIndex.get(idx);
        if (!owner) {
          warnMiss("duel", idx);
          continue;
        }
        events.push({ type: "duel", recipient_wallet: owner, taruchi_id: id });
      }
    }
  }

  // 4) FESTIVAL — the TourneyResult write is the resolve signal (mirrors
  //    tourneyAnnouncementProjector). Notify every entrant of a festival bracket.
  for (const rec of setRecordsFor(logs, TOURNEY_RESULT_TABLE_ID)) {
    const id = keyToId(rec);
    const bracket = caches.bracketById.get(id);
    if (bracket === undefined || !FESTIVAL_BRACKETS.has(bracket)) continue; // duel/non-festival
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
 * onConflict ignore makes reorg/catch-up replays no-op.
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
      // Always update caches (we need prior state across blocks), but only
      // publish once caught up so historical backfill doesn't blast old players.
      const events = extractNotifEvents(logs, caches, ctx.blockNumber);
      if (events.length === 0 || !ctx.isCaughtUp()) return;
      const inserted = await publish(ctx.supabase, events, ctx.blockNumber);
      log.info("published", { events: inserted, block: ctx.blockNumber });
    },
  };
}

// re-export so the test file can use the narrowed SetRecord shape if needed
export type { SetRecord };
