import { describe, it, expect } from "vitest";
import { concatHex, numberToHex, type Hex } from "viem";
import { resourceToHex } from "@latticexyz/common";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import {
  FESTIVAL_NAMES,
  extractFinishedFestivals,
  formatAnnouncement,
  newAnnouncements,
  type FinishedTournament,
} from "./tourneyAnnouncementProjector";

function mkTournament(id: string, name = "Festival of Flowers"): FinishedTournament {
  return { tournament_id: id, name, finished_at: "2026-06-01T00:00:00.000Z" };
}

describe("FESTIVAL_NAMES", () => {
  it("maps the three festival brackets to their display names", () => {
    expect(FESTIVAL_NAMES[4]).toBe("Festival of Buds");
    expect(FESTIVAL_NAMES[5]).toBe("Festival of Flowers");
    expect(FESTIVAL_NAMES[6]).toBe("Ascension Festival");
  });

  it("has no entry for the non-festival brackets (NULL/Rookie/Veteran/Champion)", () => {
    expect(FESTIVAL_NAMES[0]).toBeUndefined();
    expect(FESTIVAL_NAMES[1]).toBeUndefined();
    expect(FESTIVAL_NAMES[2]).toBeUndefined();
    expect(FESTIVAL_NAMES[3]).toBeUndefined();
  });
});

describe("formatAnnouncement", () => {
  it("renders the pre-formatted line", () => {
    expect(formatAnnouncement("Festival of Flowers")).toBe("Festival of Flowers has just finished.");
  });
});

describe("newAnnouncements", () => {
  it("returns only tournaments not already mirrored", () => {
    const finished = [mkTournament("A"), mkTournament("B"), mkTournament("C")];
    const fresh = newAnnouncements(finished, new Set(["A"]));
    expect(fresh.map((t) => t.tournament_id)).toEqual(["B", "C"]);
  });

  it("returns none on an idempotent replay (all already mirrored)", () => {
    const finished = [mkTournament("A"), mkTournament("B")];
    expect(newAnnouncements(finished, new Set(["A", "B"]))).toEqual([]);
  });
});

// --- chain-log decode (the SQS-reveal-hook posture) ---
const TOURNEY_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Tourney" });
const TOURNEY_RESULT_TABLE_ID = resourceToHex({ type: "offchainTable", namespace: "app", name: "TourneyResult" });

// Tourney value: players u256 @0, specs u192 @32, bracket u8 @56, status u8 @57 (B3: specs u256→u192)
function tourneyEnrollLog(id: bigint, bracket: number): StorageAdapterLog {
  const staticData = concatHex([
    numberToHex(0n, { size: 32 }), // players
    numberToHex(0n, { size: 24 }), // specs (u192)
    numberToHex(bracket, { size: 1 }), // bracket
    numberToHex(1, { size: 1 }), // status = ACTIVE
  ]);
  return mkSetRecord(TOURNEY_TABLE_ID, id, staticData);
}

// TourneyResult value: placements u256 @0, time u32 @32
function tourneyResultLog(id: bigint, time: number): StorageAdapterLog {
  const staticData = concatHex([
    numberToHex(0n, { size: 32 }), // placements
    numberToHex(time, { size: 4 }), // time
  ]);
  return mkSetRecord(TOURNEY_RESULT_TABLE_ID, id, staticData);
}

function mkSetRecord(tableId: Hex, id: bigint, staticData: Hex): StorageAdapterLog {
  return {
    eventName: "Store_SetRecord",
    args: { tableId, keyTuple: [numberToHex(id, { size: 32 })], staticData },
  } as unknown as StorageAdapterLog;
}

describe("extractFinishedFestivals", () => {
  it("decodes id + name + finished_at from enroll+result logs in one block", () => {
    const time = 1_700_000_000;
    const finished = extractFinishedFestivals(
      [tourneyEnrollLog(12345n, 5), tourneyResultLog(12345n, time)],
      new Map(),
      100,
    );
    expect(finished).toEqual([
      {
        tournament_id: "12345",
        name: "Festival of Flowers",
        finished_at: new Date(time * 1000).toISOString(),
      },
    ]);
  });

  it("uses the bracket cached from a prior block's enroll write", () => {
    const map = new Map<string, number>();
    // Block N: enroll only — caches bracket, emits nothing.
    expect(extractFinishedFestivals([tourneyEnrollLog(7n, 6)], map, 1)).toEqual([]);
    expect(map.get("7")).toBe(6);
    // Block M: result only — resolves via the cached bracket.
    const finished = extractFinishedFestivals([tourneyResultLog(7n, 1_700_000_000)], map, 2);
    expect(finished.map((t) => [t.tournament_id, t.name])).toEqual([["7", "Ascension Festival"]]);
  });

  it("skips non-festival brackets (e.g. a Veteran duel-tier tourney)", () => {
    const finished = extractFinishedFestivals(
      [tourneyEnrollLog(9n, 2), tourneyResultLog(9n, 1_700_000_000)],
      new Map(),
      3,
    );
    expect(finished).toEqual([]);
  });

  it("skips a result whose enroll was never seen (unknown bracket)", () => {
    const finished = extractFinishedFestivals([tourneyResultLog(42n, 1_700_000_000)], new Map(), 4);
    expect(finished).toEqual([]);
  });
});
