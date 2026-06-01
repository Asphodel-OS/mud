import { describe, it, expect } from "vitest";
import { FESTIVAL_NAMES, formatAnnouncement, newAnnouncements, type FinishedTournament } from "./supabasePublisher";

function mkTournament(id: string, name = "Festival of Flowers"): FinishedTournament {
  return { tournament_id: id, name, finished_at: "2026-06-01T00:00:00.000Z" };
}

describe("FESTIVAL_NAMES", () => {
  it("maps the three festival brackets to their display names", () => {
    expect(FESTIVAL_NAMES[4]).toBe("Festival of Consecration");
    expect(FESTIVAL_NAMES[5]).toBe("Festival of Flowers");
    expect(FESTIVAL_NAMES[6]).toBe("Ascension Festival");
  });

  it("has no entry for duel brackets (1/2/3)", () => {
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

  it("returns all when nothing is mirrored yet", () => {
    const finished = [mkTournament("A"), mkTournament("B")];
    const fresh = newAnnouncements(finished, new Set());
    expect(fresh.map((t) => t.tournament_id)).toEqual(["A", "B"]);
  });

  it("returns none on an idempotent re-tick (all already mirrored)", () => {
    const finished = [mkTournament("A"), mkTournament("B")];
    const fresh = newAnnouncements(finished, new Set(["A", "B"]));
    expect(fresh).toEqual([]);
  });
});
