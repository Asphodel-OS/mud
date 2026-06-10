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
// Duel: aIdx u32 @0, bIdx u32 @4, bracket u8 @8, status u8 @9, specs u256 @10
function duelLog(id: bigint, a: number, b: number, status: number): StorageAdapterLog {
  return mkSetRecord(
    DUEL,
    id,
    concatHex([
      numberToHex(a, { size: 4 }),
      numberToHex(b, { size: 4 }),
      numberToHex(0, { size: 1 }),
      numberToHex(status, { size: 1 }),
      numberToHex(0n, { size: 32 }),
    ]),
  );
}
// Tourney: players u256 @0, specs u256 @32, bracket u8 @64, status u8 @65
function tourneyLog(id: bigint, bracket: number, packedPlayers: bigint): StorageAdapterLog {
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
// TourneyResult: placements u256 @0, time u32 @32
function tourneyResultLog(id: bigint): StorageAdapterLog {
  return mkSetRecord(TOURNEY_RESULT, id, concatHex([numberToHex(0n, { size: 32 }), numberToHex(0, { size: 4 })]));
}

/** pack indices into a uint32[8] word (slot order irrelevant to the projector). */
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
  it("fires only on the UNREVEALED→IDLE transition", () => {
    const c = emptyCaches();
    // mint commit: Core + status UNREVEALED → no event, learns owner + prior state
    expect(extractNotifEvents([coreLog(1n, OWNER_A, 10), statusLog(1n, 0)], c, 1)).toEqual([]);
    // reveal: status IDLE → mint
    const ev = extractNotifEvents([statusLog(1n, 1)], c, 2);
    expect(ev).toEqual([{ type: "mint", recipient_wallet: OWNER_A, taruchi_id: "1" }]);
  });

  it("does NOT fire on IDLE without a prior UNREVEALED (training/duel return)", () => {
    const c = emptyCaches();
    c.ownerById.set("1", OWNER_A);
    c.lastStateById.set("1", 6); // prior = TRAINING
    expect(extractNotifEvents([statusLog(1n, 1)], c, 5)).toEqual([]);
  });

  it("skips when the owner isn't cached", () => {
    const c = emptyCaches();
    c.lastStateById.set("1", 0);
    expect(extractNotifEvents([statusLog(1n, 1)], c, 5)).toEqual([]);
  });
});

describe("extractNotifEvents — DUEL", () => {
  it("fires once on transition to COMPLETED, for both players", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(100n, OWNER_A, 10), coreLog(200n, OWNER_B, 20)], c, 1); // learn owners
    const ev = extractNotifEvents([duelLog(999n, 10, 20, 2)], c, 2);
    expect(ev).toEqual([
      { type: "duel", recipient_wallet: OWNER_A, taruchi_id: "999" },
      { type: "duel", recipient_wallet: OWNER_B, taruchi_id: "999" },
    ]);
  });

  it("does NOT re-fire while already COMPLETED", () => {
    const c = emptyCaches();
    c.ownerByIndex.set(10, OWNER_A);
    c.lastDuelStatus.set("999", 2); // already completed
    expect(extractNotifEvents([duelLog(999n, 10, 0, 2)], c, 3)).toEqual([]);
  });
});

describe("extractNotifEvents — FESTIVAL", () => {
  it("notifies every entrant on the result of a festival bracket", () => {
    const c = emptyCaches();
    extractNotifEvents([coreLog(100n, OWNER_A, 10), coreLog(200n, OWNER_B, 20)], c, 1);
    extractNotifEvents([tourneyLog(5000n, 5, packPlayers(10, 20))], c, 2); // enroll: bracket 5 (festival)
    const ev = extractNotifEvents([tourneyResultLog(5000n)], c, 3);
    expect(ev).toEqual(
      expect.arrayContaining([
        { type: "festival", recipient_wallet: OWNER_A, taruchi_id: "5000" },
        { type: "festival", recipient_wallet: OWNER_B, taruchi_id: "5000" },
      ]),
    );
    expect(ev).toHaveLength(2);
  });

  it("ignores non-festival (duel-tier) brackets", () => {
    const c = emptyCaches();
    c.ownerByIndex.set(10, OWNER_A);
    extractNotifEvents([tourneyLog(6000n, 2, packPlayers(10))], c, 1); // bracket 2 = Veteran (not festival)
    expect(extractNotifEvents([tourneyResultLog(6000n)], c, 2)).toEqual([]);
  });
});
