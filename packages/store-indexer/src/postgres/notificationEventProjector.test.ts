import { describe, it, expect, vi } from "vitest";
import { concatHex, numberToHex, type Hex } from "viem";
import { resourceToHex } from "@latticexyz/common";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emptyCaches,
  extractNotifEvents,
  filterToSubscribed,
  hydrateNotifCaches,
  unpackIndices,
  type HydrationRecords,
  type NotifEvent,
  type SetRecord,
} from "./notificationEventProjector";

const CORE = resourceToHex({ type: "table", namespace: "app", name: "TaruchiCore" });
const STATUS = resourceToHex({ type: "table", namespace: "app", name: "TaruchiStatus" });
const DUEL = resourceToHex({ type: "table", namespace: "app", name: "Duel" });
const TOURNEY = resourceToHex({ type: "table", namespace: "app", name: "Tourney" });
const TOURNEY_RESULT = resourceToHex({ type: "offchainTable", namespace: "app", name: "TourneyResult" });

const OWNER_A = ("0x" + "a".repeat(40)) as Hex;
const OWNER_B = ("0x" + "b".repeat(40)) as Hex;

const IDLE = 1;

function mkSetRecord(tableId: Hex, id: bigint, staticData: Hex): StorageAdapterLog {
  return {
    eventName: "Store_SetRecord",
    args: { tableId, keyTuple: [numberToHex(id, { size: 32 })], staticData },
  } as unknown as StorageAdapterLog;
}

// TaruchiCore: index u32 @0 (4), owner address @4 (20)
function coreLog(id: bigint, owner: Hex, index: number): StorageAdapterLog {
  return mkSetRecord(CORE, id, concatHex([numberToHex(index, { size: 4 }), owner]));
}
// TaruchiStatus: affinity u8 @0, state u8 @1, remaining fields occupy bytes @2..32
function statusLog(id: bigint, state: number): StorageAdapterLog {
  return mkSetRecord(
    STATUS,
    id,
    concatHex([numberToHex(0, { size: 1 }), numberToHex(state, { size: 1 }), numberToHex(0n, { size: 30 })]),
  );
}
// Duel ENROLL SetRecord: aIdx u32 @0, bIdx u32 @4, bracket u8 @8, status u8 @9, specs u48 @10
// (resolve is a status splice we don't watch — we trigger off TourneyResult).
// specs is the LAST field, so B3 (u256→u48) doesn't shift the offsets we read (a/b/bracket).
function duelEnrollLog(id: bigint, a: number, b: number): StorageAdapterLog {
  return mkSetRecord(
    DUEL,
    id,
    concatHex([
      numberToHex(a, { size: 4 }),
      numberToHex(b, { size: 4 }),
      numberToHex(1, { size: 1 }), // bracket
      numberToHex(1, { size: 1 }), // status = ACTIVE
      numberToHex(0n, { size: 6 }), // specs (u48)
    ]),
  );
}
// Tourney enroll: players u256 @0, specs u192 @32, bracket u8 @56, status u8 @57 (B3: specs u256→u192)
function tourneyEnrollLog(id: bigint, bracket: number, packedPlayers: bigint): StorageAdapterLog {
  return mkSetRecord(
    TOURNEY,
    id,
    concatHex([
      numberToHex(packedPlayers, { size: 32 }),
      numberToHex(0n, { size: 24 }), // specs (u192)
      numberToHex(bracket, { size: 1 }),
      numberToHex(1, { size: 1 }),
    ]),
  );
}
// TourneyResult: the resolve signal for BOTH duels and festivals (full SetRecord).
function tourneyResultLog(id: bigint): StorageAdapterLog {
  return mkSetRecord(TOURNEY_RESULT, id, concatHex([numberToHex(0n, { size: 32 }), numberToHex(0, { size: 4 })]));
}

// Hydration consumes SetRecord ({ keyTuple, staticData }), not StorageAdapterLog — pull
// .args off the log helpers above so both paths share one staticData layout per table.
function toSetRecord(l: StorageAdapterLog): SetRecord {
  const { keyTuple, staticData } = (l as unknown as { args: SetRecord }).args;
  return { keyTuple, staticData };
}
const coreRec = (id: bigint, owner: Hex, index: number): SetRecord => toSetRecord(coreLog(id, owner, index));
const statusRec = (id: bigint, state: number): SetRecord => toSetRecord(statusLog(id, state));
const duelRec = (id: bigint, a: number, b: number): SetRecord => toSetRecord(duelEnrollLog(id, a, b));
const tourneyRec = (id: bigint, bracket: number, packedPlayers: bigint): SetRecord =>
  toSetRecord(tourneyEnrollLog(id, bracket, packedPlayers));

function packPlayers(...idx: number[]): bigint {
  let p = 0n;
  idx.forEach((v, i) => {
    p |= BigInt(v) << (32n * BigInt(i));
  });
  return p;
}

describe("unpackIndices", () => {
  it("returns all non-zero indices, drops empty slots", () => {
    expect(unpackIndices(packPlayers(10, 20, 0, 30))).toEqual(expect.arrayContaining([10, 20, 30]));
    expect(unpackIndices(packPlayers(10, 20, 0, 30))).toHaveLength(3);
    expect(unpackIndices(0n)).toEqual([]);
  });
});

describe("extractNotifEvents — MINT", () => {
  it("fires on the FIRST TaruchiStatus write landing IDLE (the reveal)", () => {
    const c = emptyCaches();
    // mint writes Core; reveal is the first Status write, set directly to IDLE.
    const ev = extractNotifEvents([coreLog(1n, OWNER_A, 10), statusLog(1n, IDLE)], c, 1);
    expect(ev).toEqual([{ type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" }]);
  });

  it("does NOT re-fire on a later IDLE write (training/duel return to IDLE)", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(1n, OWNER_A, 10), statusLog(1n, IDLE)], c, 1); // reveal (fires)
    expect(extractNotifEvents([statusLog(1n, IDLE)], c, 9)).toEqual([]); // already seen
  });

  it("skips when the owner isn't cached", () => {
    const c = emptyCaches();
    expect(extractNotifEvents([statusLog(5n, IDLE)], c, 1)).toEqual([]);
  });

  it("re-fires a reveal after a reorg replay (block regresses → mint-seen gate cleared)", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(1n, OWNER_A, 10), statusLog(1n, IDLE)], c, 100); // reveal at block 100
    // reorg: indexer re-processes from an earlier block; the reveal re-lands.
    const ev = extractNotifEvents([statusLog(1n, IDLE)], c, 98);
    expect(ev).toEqual([{ type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" }]);
  });

  it("preserves prior-state ACROSS replayed blocks — the gate clears once at the boundary, not every block", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(1n, OWNER_A, 10)], c, 100); // learn owner, lastBlock=100
    // reorg boundary: block regresses to 98. Reveal re-lands here (first write
    // since the gate cleared) → mint re-fires. This is the boundary block.
    expect(extractNotifEvents([statusLog(1n, IDLE)], c, 98)).toEqual([
      { type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" },
    ]);
    // Next replayed block (99 > 98) climbs forward — must NOT re-clear the gate.
    // A training-return-to-IDLE on the already-revealed taru must stay silent.
    // (With the old Math.max bug, 99 < highWater(100) re-cleared → false mint.)
    expect(extractNotifEvents([statusLog(1n, IDLE)], c, 99)).toEqual([]);
  });
});

describe("extractNotifEvents — DUEL (resolves via TourneyResult, not a status splice)", () => {
  it("fires for both players when the duel's TourneyResult is written", () => {
    const c = emptyCaches();
    // enroll: learn owners + duel player indices. No event yet.
    expect(
      extractNotifEvents([coreLog(100n, OWNER_A, 10), coreLog(200n, OWNER_B, 20), duelEnrollLog(999n, 10, 20)], c, 1),
    ).toEqual([]);
    // resolve: TourneyResult write for the duel id.
    expect(extractNotifEvents([tourneyResultLog(999n)], c, 2)).toEqual([
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "999" },
      { type: "duel", recipient_wallet: OWNER_B, taruchi_id: "999" },
    ]);
  });

  it("skips a duel player whose owner isn't cached", () => {
    const c = emptyCaches();
    c.ownerByIndex.set(10, OWNER_A); // only player 10 known
    extractNotifEvents([duelEnrollLog(999n, 10, 20)], c, 1);
    expect(extractNotifEvents([tourneyResultLog(999n)], c, 2)).toEqual([
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "999" },
    ]);
  });
});

describe("extractNotifEvents — FESTIVAL", () => {
  it("notifies every entrant on the result of a festival bracket", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(100n, OWNER_A, 10), coreLog(200n, OWNER_B, 20)], c, 1);
    extractNotifEvents([tourneyEnrollLog(5000n, 5, packPlayers(10, 20))], c, 2); // bracket 5 = festival
    const ev = extractNotifEvents([tourneyResultLog(5000n)], c, 3);
    expect(ev).toEqual(
      expect.arrayContaining([
        { type: "festival", recipient_wallet: OWNER_A, taruchi_id: "5000" },
        { type: "festival", recipient_wallet: OWNER_B, taruchi_id: "5000" },
      ]),
    );
    expect(ev).toHaveLength(2);
  });

  it("ignores a non-festival (duel-tier) tourney bracket", () => {
    const c = emptyCaches();
    c.ownerByIndex.set(10, OWNER_A);
    extractNotifEvents([tourneyEnrollLog(6000n, 2, packPlayers(10))], c, 1); // bracket 2 = Veteran
    expect(extractNotifEvents([tourneyResultLog(6000n)], c, 2)).toEqual([]);
  });
});

describe("hydrateNotifCaches", () => {
  it("hydrated duel enroll + owners: a post-restart TourneyResult notifies both players", () => {
    const records: HydrationRecords = {
      core: [coreRec(100n, OWNER_A, 10), coreRec(200n, OWNER_B, 20)],
      status: [],
      duels: [duelRec(999n, 10, 20)],
      tourneys: [],
    };
    const { caches: c } = hydrateNotifCaches(records);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ev = extractNotifEvents([tourneyResultLog(999n)], c, 2);
    writeSpy.mockRestore();
    expect(ev).toEqual([
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "999" },
      { type: "duel", recipient_wallet: OWNER_B, taruchi_id: "999" },
    ]);
    // subsumes spec test 5: the duel is known via hydration, so no result-unknown-id warn.
    const warnedUnknown = writeSpy.mock.calls.some(([line]) => String(line).includes("result-unknown-id"));
    expect(warnedUnknown).toBe(false);
  });

  it("hydrated festival enroll + owners: a post-restart result notifies every entrant", () => {
    const records: HydrationRecords = {
      core: [coreRec(100n, OWNER_A, 10), coreRec(200n, OWNER_B, 20)],
      status: [],
      duels: [],
      tourneys: [tourneyRec(5000n, 5, packPlayers(10, 20))], // bracket 5 = festival
    };
    const { caches: c } = hydrateNotifCaches(records);
    const ev = extractNotifEvents([tourneyResultLog(5000n)], c, 3);
    expect(ev).toEqual(
      expect.arrayContaining([
        { type: "festival", recipient_wallet: OWNER_A, taruchi_id: "5000" },
        { type: "festival", recipient_wallet: OWNER_B, taruchi_id: "5000" },
      ]),
    );
    expect(ev).toHaveLength(2);
  });

  it("seeds lastStateById so a post-restart IDLE Status write is not a false mint", () => {
    const records: HydrationRecords = {
      core: [coreRec(1n, OWNER_A, 10)],
      status: [statusRec(1n, IDLE)],
      duels: [],
      tourneys: [],
    };
    const { caches: c } = hydrateNotifCaches(records);
    expect(extractNotifEvents([statusLog(1n, IDLE)], c, 5)).toEqual([]);
  });

  it("returns caches only and fires nothing without a result log", () => {
    const records: HydrationRecords = {
      core: [coreRec(100n, OWNER_A, 10), coreRec(200n, OWNER_B, 20)],
      status: [],
      duels: [duelRec(999n, 10, 20)],
      tourneys: [],
    };
    const { caches: c } = hydrateNotifCaches(records);
    // extractNotifEvents unconditionally sets caches.lastBlock — assert BEFORE calling it.
    expect(c.lastBlock).toBe(-1);
    expect(extractNotifEvents([], c, 1)).toEqual([]);
  });

  it("skips static_data rows shorter than the required offsets and reports the skipped count", () => {
    const validCore = coreRec(1n, OWNER_A, 10);
    const shortCore: SetRecord = { keyTuple: coreRec(2n, OWNER_B, 99).keyTuple, staticData: "0x00" as Hex };
    const validTourney = tourneyRec(5000n, 5, packPlayers(10, 20));
    const shortTourney: SetRecord = {
      keyTuple: tourneyRec(7000n, 5, packPlayers(10)).keyTuple,
      staticData: "0x00" as Hex,
    };
    const records: HydrationRecords = {
      core: [validCore, shortCore],
      status: [],
      duels: [],
      tourneys: [validTourney, shortTourney],
    };
    const { caches, skipped } = hydrateNotifCaches(records);
    expect(caches.ownerById.has("1")).toBe(true);
    expect(caches.ownerById.has("2")).toBe(false);
    expect(caches.bracketById.has("5000")).toBe(true);
    expect(caches.bracketById.has("7000")).toBe(false);
    expect(skipped).toBe(2);
  });

  it("hydrates empty record sets to empty-equivalent caches with no skips", () => {
    const { caches, skipped } = hydrateNotifCaches({ core: [], status: [], duels: [], tourneys: [] });
    expect(caches).toEqual(emptyCaches());
    expect(skipped).toBe(0);
  });
});

// Minimal stub of the supabase-js builder chain filterToSubscribed uses:
//   from("push_subscriptions").select(cols).in("wallet", wallets) -> {data,error}
// Records the wallet list passed to `.in` so we can assert the batched, deduped query.
type SubQueryResult = Promise<{ data: unknown[] | null; error: { message: string } | null }>;

function fakeSupabase(
  rows: unknown[],
  opts: { error?: { message: string } } = {},
): { client: SupabaseClient; calls: { wallets?: readonly string[] } } {
  const calls: { wallets?: readonly string[] } = {};
  const builder = {
    select: (): { in: (col: string, wallets: readonly string[]) => SubQueryResult } => ({
      in: (_col: string, wallets: readonly string[]): SubQueryResult => {
        calls.wallets = wallets;
        return Promise.resolve(opts.error ? { data: null, error: opts.error } : { data: rows, error: null });
      },
    }),
  };
  const client = { from: (): typeof builder => builder } as unknown as SupabaseClient;
  return { client, calls };
}

const evMint = (w: Hex): NotifEvent => ({ type: "mint", recipient_wallet: w, taruchi_id: "1" });

describe("filterToSubscribed — source-side opt-in gate", () => {
  it("keeps an event when the recipient is subscribed for that type", async () => {
    const { client } = fakeSupabase([{ wallet: OWNER_A, type_mint: true, type_duel: false, type_festival: false }]);
    expect(await filterToSubscribed(client, [evMint(OWNER_A)])).toEqual([evMint(OWNER_A)]);
  });

  it("drops an event when the recipient has no subscription row", async () => {
    const { client } = fakeSupabase([]);
    expect(await filterToSubscribed(client, [evMint(OWNER_A)])).toEqual([]);
  });

  it("drops an event when the wallet is subscribed but that TYPE is off", async () => {
    const { client } = fakeSupabase([{ wallet: OWNER_A, type_mint: false, type_duel: true, type_festival: false }]);
    expect(await filterToSubscribed(client, [evMint(OWNER_A)])).toEqual([]);
  });

  it("treats a wallet as subscribed if ANY device row enables the type", async () => {
    const { client } = fakeSupabase([
      { wallet: OWNER_A, type_mint: false, type_duel: false, type_festival: false }, // device 1: off
      { wallet: OWNER_A, type_mint: true, type_duel: false, type_festival: false }, // device 2: on
    ]);
    expect(await filterToSubscribed(client, [evMint(OWNER_A)])).toEqual([evMint(OWNER_A)]);
  });

  it("filters a mixed batch to only subscribed recipients, with one deduped query", async () => {
    const { client, calls } = fakeSupabase([
      { wallet: OWNER_A, type_mint: true, type_duel: true, type_festival: false },
    ]);
    const events: NotifEvent[] = [
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "9" },
      { type: "duel", recipient_wallet: OWNER_B, taruchi_id: "9" }, // B not subscribed
      { type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" },
    ];
    expect(await filterToSubscribed(client, events)).toEqual([
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "9" },
      { type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" },
    ]);
    // A appears twice in events but is queried once; one batched IN query.
    expect(calls.wallets).toEqual([OWNER_A, OWNER_B]);
  });

  it("returns empty without querying when there are no events", async () => {
    const { client, calls } = fakeSupabase([]);
    expect(await filterToSubscribed(client, [])).toEqual([]);
    expect(calls.wallets).toBeUndefined();
  });

  it("throws (fail-closed) when the subscription read errors", async () => {
    const { client } = fakeSupabase([], { error: { message: "db down" } });
    await expect(filterToSubscribed(client, [evMint(OWNER_A)])).rejects.toThrow(/push_subscriptions/);
  });
});
