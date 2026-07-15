import { afterEach, describe, it, expect, vi } from "vitest";
import { concatHex, numberToHex, type Hex } from "viem";
import { resourceToHex } from "@latticexyz/common";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import type { ProjectorContext } from "./supabasePush";
import {
  FESTIVAL_NAMES,
  createTourneyAnnouncementProjector,
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
const DUEL_TABLE_ID = resourceToHex({ type: "table", namespace: "app", name: "Duel" });

// The projector reads only the Duel key (identity), never its staticData —
// placeholder value bytes are deliberate.
function duelEnrollLog(id: bigint): StorageAdapterLog {
  return mkSetRecord(DUEL_TABLE_ID, id, "0x00");
}

// `log` is module-private and import-bound, so the warn is only observable at
// its sink: stdout (logger routes warn there; only error goes to stderr).
const WARN_SNIPPET = "tourney result with no known bracket";
function spyWarnLines(): { count: () => number } {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return { count: () => spy.mock.calls.filter((call) => String(call[0]).includes(WARN_SNIPPET)).length };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
      new Set(),
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
    expect(extractFinishedFestivals([tourneyEnrollLog(7n, 6)], map, new Set(), 1)).toEqual([]);
    expect(map.get("7")).toBe(6);
    // Block M: result only — resolves via the cached bracket.
    const finished = extractFinishedFestivals([tourneyResultLog(7n, 1_700_000_000)], map, new Set(), 2);
    expect(finished.map((t) => [t.tournament_id, t.name])).toEqual([["7", "Ascension Festival"]]);
  });

  it("skips non-festival brackets (e.g. a Veteran duel-tier tourney)", () => {
    const finished = extractFinishedFestivals(
      [tourneyEnrollLog(9n, 2), tourneyResultLog(9n, 1_700_000_000)],
      new Map(),
      new Set(),
      3,
    );
    expect(finished).toEqual([]);
  });

  it("warns exactly once for a result that is neither a known duel nor a known tourney", () => {
    const warns = spyWarnLines();
    const finished = extractFinishedFestivals([tourneyResultLog(42n, 1_700_000_000)], new Map(), new Set(), 4);
    expect(finished).toEqual([]);
    expect(warns.count()).toBe(1);
  });

  it("keeps the festival bracket cached after its result (reorg re-mirror)", () => {
    const warns = spyWarnLines();
    const map = new Map<string, number>();
    const time = 1_700_000_000;
    const logs = [tourneyEnrollLog(600n, 5), tourneyResultLog(600n, time)];
    expect(extractFinishedFestivals(logs, map, new Set(), 5).map((t) => t.tournament_id)).toEqual(["600"]);
    // Reorg replays only the resolve block: the cached bracket must still name it.
    const replay = extractFinishedFestivals([tourneyResultLog(600n, time)], map, new Set(), 5);
    expect(replay.map((t) => t.tournament_id)).toEqual(["600"]);
    expect(warns.count()).toBe(0);
  });
});

describe("extractFinishedFestivals — duel results (duels share the TourneyResult table)", () => {
  it("skips a duel result silently and consumes its id (same block)", () => {
    const warns = spyWarnLines();
    const duelIds = new Set<string>();
    const finished = extractFinishedFestivals(
      [duelEnrollLog(500n), tourneyResultLog(500n, 1_700_000_000)],
      new Map(),
      duelIds,
      10,
    );
    expect(finished).toEqual([]);
    expect(warns.count()).toBe(0);
    expect(duelIds.has("500")).toBe(false);
  });

  it("caches the duel id from a prior block's enroll and consumes it at the result", () => {
    const warns = spyWarnLines();
    const duelIds = new Set<string>();
    expect(extractFinishedFestivals([duelEnrollLog(501n)], new Map(), duelIds, 11)).toEqual([]);
    expect(duelIds.has("501")).toBe(true);
    expect(extractFinishedFestivals([tourneyResultLog(501n, 1_700_000_000)], new Map(), duelIds, 12)).toEqual([]);
    expect(warns.count()).toBe(0);
    expect(duelIds.has("501")).toBe(false);
  });

  it("announces only the festival when a duel and a festival resolve in the same block", () => {
    const warns = spyWarnLines();
    const time = 1_700_000_000;
    const finished = extractFinishedFestivals(
      [duelEnrollLog(700n), tourneyEnrollLog(701n, 4), tourneyResultLog(700n, time), tourneyResultLog(701n, time)],
      new Map(),
      new Set(),
      13,
    );
    expect(finished.map((t) => [t.tournament_id, t.name])).toEqual([["701", "Festival of Buds"]]);
    expect(warns.count()).toBe(0);
  });
});

// --- createTourneyAnnouncementProjector seed param (end-to-end onBlock) ---

// Builder-chain stub for the two calls publishToSupabase makes on
// "tournament_results": the unconditional pre-upsert existing-ids read
// (.select().in()) and the upsert itself. "announcements" is never touched
// because these tests use isCaughtUp: () => false.
function fakeTourneySupabase(): { client: SupabaseClient; upsertRows: FinishedTournament[] } {
  const upsertRows: FinishedTournament[] = [];
  const resultsBuilder = {
    select: () => ({
      in: () => Promise.resolve({ data: [], error: null }),
    }),
    upsert: (rows: FinishedTournament[]): Promise<{ error: null }> => {
      upsertRows.push(...rows);
      return Promise.resolve({ error: null });
    },
  };
  const client = {
    from: (table: string) => {
      if (table === "tournament_results") return resultsBuilder;
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, upsertRows };
}

function fakeCtx(client: SupabaseClient, blockNumber: number): ProjectorContext {
  return { supabase: client, blockNumber, isCaughtUp: () => false };
}

describe("createTourneyAnnouncementProjector — seed param", () => {
  it("seeded bracketById: a festival result post-restart resolves to the announcement/mirror without a bracket warn", async () => {
    const warns = spyWarnLines();
    const { client, upsertRows } = fakeTourneySupabase();
    const p = createTourneyAnnouncementProjector({ bracketById: new Map([["600", 5]]) });
    const time = 1_700_000_000;
    await p.onBlock([tourneyResultLog(600n, time)], fakeCtx(client, 20));
    expect(upsertRows.map((r) => [r.tournament_id, r.name])).toEqual([["600", "Festival of Flowers"]]);
    expect(warns.count()).toBe(0);
  });

  it("seeded knownDuelIds: a duel result is consumed with no announcement and no bracket warn", async () => {
    const warns = spyWarnLines();
    const { client, upsertRows } = fakeTourneySupabase();
    const p = createTourneyAnnouncementProjector({ knownDuelIds: new Set(["500"]) });
    await p.onBlock([tourneyResultLog(500n, 1_700_000_000)], fakeCtx(client, 21));
    expect(upsertRows).toEqual([]);
    expect(warns.count()).toBe(0);
  });

  it("does not share seed collections with the caller", async () => {
    const b = new Map([["600", 5]]);
    const d = new Set(["500"]);
    const p = createTourneyAnnouncementProjector({ bracketById: b, knownDuelIds: d });
    b.set("600", 2);
    b.set("999", 4);
    d.clear();

    const warns = spyWarnLines();
    const { client: client600, upsertRows: rows600 } = fakeTourneySupabase();
    await p.onBlock([tourneyResultLog(600n, 1_700_000_000)], fakeCtx(client600, 22));
    expect(rows600.map((r) => [r.tournament_id, r.name])).toEqual([["600", "Festival of Flowers"]]);

    const { client: client500, upsertRows: rows500 } = fakeTourneySupabase();
    await p.onBlock([tourneyResultLog(500n, 1_700_000_000)], fakeCtx(client500, 23));
    expect(rows500).toEqual([]);
    expect(warns.count()).toBe(0);
  });
});
