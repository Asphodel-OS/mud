import { describe, it, expect } from "vitest";
import { concatHex, numberToHex, type Hex } from "viem";
import { resourceToHex } from "@latticexyz/common";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import { emptyCaches, extractNotifEvents, unpackIndices } from "./notificationEventProjector";

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

// TaruchiCore: owner address @0 (20), index u32 @20 (4)
function coreLog(id: bigint, owner: Hex, index: number): StorageAdapterLog {
  return mkSetRecord(CORE, id, concatHex([owner, numberToHex(index, { size: 4 })]));
}
// TaruchiStatus: affinity u8 @0, state u8 @1, then 34 trailing bytes
function statusLog(id: bigint, state: number): StorageAdapterLog {
  return mkSetRecord(
    STATUS,
    id,
    concatHex([numberToHex(0, { size: 1 }), numberToHex(state, { size: 1 }), numberToHex(0n, { size: 34 })]),
  );
}
// Duel ENROLL SetRecord: aIdx u32 @0, bIdx u32 @4, bracket u8 @8, status u8 @9, specs u256 @10
// (resolve is a status splice we don't watch — we trigger off TourneyResult).
function duelEnrollLog(id: bigint, a: number, b: number): StorageAdapterLog {
  return mkSetRecord(
    DUEL,
    id,
    concatHex([
      numberToHex(a, { size: 4 }),
      numberToHex(b, { size: 4 }),
      numberToHex(1, { size: 1 }), // bracket
      numberToHex(1, { size: 1 }), // status = ACTIVE
      numberToHex(0n, { size: 32 }), // specs
    ]),
  );
}
// Tourney enroll: players u256 @0, specs u256 @32, bracket u8 @64, status u8 @65
function tourneyEnrollLog(id: bigint, bracket: number, packedPlayers: bigint): StorageAdapterLog {
  return mkSetRecord(
    TOURNEY,
    id,
    concatHex([
      numberToHex(packedPlayers, { size: 32 }),
      numberToHex(0n, { size: 32 }),
      numberToHex(bracket, { size: 1 }),
      numberToHex(1, { size: 1 }),
    ]),
  );
}
// TourneyResult: the resolve signal for BOTH duels and festivals (full SetRecord).
function tourneyResultLog(id: bigint): StorageAdapterLog {
  return mkSetRecord(TOURNEY_RESULT, id, concatHex([numberToHex(0n, { size: 32 }), numberToHex(0, { size: 4 })]));
}

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
