import { describe, expect, it } from "vitest";
import { packU32 } from "./packUtils";
import type { TaruchiLeaderboardRow } from "./types";
import {
  buildTaruchiDetails,
  traitCode,
  unpackStats,
  unpackTraits,
  type BuildTaruchiDetailsInput,
  type TaruchiStatusRow,
} from "./buildTaruchiDetails";

const MASK_16 = 0xffffn;
const i16 = (n: number): bigint => BigInt(n & 0xffff);
const packStats = (health: number, power: number, harmony: number, violence: number): bigint =>
  i16(health) | (i16(power) << 16n) | (i16(harmony) << 32n) | (i16(violence) << 48n);
const packTraits = (flower: number, body: number, eye: number, mouth: number, equipment: number): bigint =>
  BigInt(flower) | (BigInt(body) << 8n) | (BigInt(eye) << 16n) | (BigInt(mouth) << 24n) | (BigInt(equipment) << 32n);

describe("unpackStats", () => {
  it("unpacks four int16 lanes, sign-extended", () => {
    expect(unpackStats(packStats(50, 5, -3, 100))).toEqual({ health: 50, power: 5, harmony: -3, violence: 100 });
  });
  it("handles the int16 extremes", () => {
    expect(unpackStats(packStats(32767, -32768, 0, -1))).toEqual({
      health: 32767,
      power: -32768,
      harmony: 0,
      violence: -1,
    });
  });
  it("zero packs to all-zero stats", () => {
    expect(unpackStats(0n)).toEqual({ health: 0, power: 0, harmony: 0, violence: 0 });
  });
});

describe("unpackTraits / traitCode", () => {
  it("unpacks the five slots from the uint40 layout", () => {
    expect(unpackTraits(packTraits(1, 2, 3, 4, 5))).toEqual({ flower: 1, body: 2, eye: 3, mouth: 4, equipment: 5 });
  });
  it("builds the BBEEMMEEFF code (body/eye/mouth/equipment/flower)", () => {
    expect(traitCode({ body: 2, eye: 3, mouth: 4, equipment: 5, flower: 1 })).toBe("0203040501");
  });
});

function lbRow(
  over: Partial<TaruchiLeaderboardRow> & Pick<TaruchiLeaderboardRow, "taruchiId" | "taruchiIndex" | "ownerWallet">,
): TaruchiLeaderboardRow {
  return {
    name: "",
    state: 1,
    imageUrl: "",
    wins: 0,
    losses: 0,
    tournaments: 0,
    bestPlacement: 8,
    winrate: 0,
    qualified: false,
    onyxWon: 0,
    onyxSpent: 0,
    ...over,
  };
}

function status(over: Partial<TaruchiStatusRow> & Pick<TaruchiStatusRow, "id">): TaruchiStatusRow {
  return {
    state: 1,
    level: 1,
    xp: 0,
    trainingPoints: 0,
    affinity: 0,
    budIndex: 0,
    traits: 0n,
    stats: 0n,
    ...over,
  };
}

describe("buildTaruchiDetails", () => {
  const cores = [
    { id: 100n, owner: "0xAAA", index: 1 },
    { id: 200n, owner: "0xBBB", index: 2 },
    { id: 300n, owner: "0xCCC", index: 3 },
  ];
  const statuses: TaruchiStatusRow[] = [
    status({
      id: 100n,
      state: 1,
      level: 5,
      xp: 10,
      trainingPoints: 2,
      affinity: 4,
      traits: packTraits(1, 2, 3, 4, 5),
      stats: packStats(50, 5, -3, 100),
    }),
    status({ id: 200n, state: 4, level: 11, budIndex: 7, affinity: 6 }),
    status({ id: 300n, state: 1, level: 1, affinity: 3 }),
  ];
  const names = [{ id: 100n, name: "Alpha" }];
  // index 1 beats index 2 in a rookie duel (bracket 1). placements slot0=winner.
  const duels = [{ id: 999n, status: 2, bracket: 1, playerAIndex: 1, playerBIndex: 2 }];
  const results = [{ id: 999n, placements: packU32([1, 2]), time: 0 }];
  const byTaruchi = new Map<string, TaruchiLeaderboardRow>([
    [
      "100",
      lbRow({
        taruchiId: 100n,
        taruchiIndex: 1,
        ownerWallet: "0xaaa",
        wins: 1,
        losses: 0,
        tournaments: 1,
        bestPlacement: 1,
        winrate: 1,
        name: "Alpha",
      }),
    ],
    [
      "200",
      lbRow({
        taruchiId: 200n,
        taruchiIndex: 2,
        ownerWallet: "0xbbb",
        wins: 0,
        losses: 1,
        tournaments: 1,
        bestPlacement: 2,
      }),
    ],
  ]);

  const input: BuildTaruchiDetailsInput = {
    tourneys: [],
    duels,
    results,
    cores,
    statuses,
    names,
    byTaruchi,
    spriteFor: (core) => `sprite/${core.index}`,
    decodeName: (s) => s,
  };

  const details = buildTaruchiDetails(input);

  it("builds onchain status + unpacked stats/traits for a named taru", () => {
    const d = details.get("100")!;
    expect(d.name).toBe("Alpha");
    expect(d.level).toBe(5);
    expect(d.xp).toBe(10);
    expect(d.trainingPoints).toBe(2);
    expect(d.affinity).toBe(4);
    expect(d.imageUrl).toBe("sprite/1");
    expect(d.traitCode).toBe("0203040501");
    expect(d.traits).toEqual({ flower: 1, body: 2, eye: 3, mouth: 4, equipment: 5 });
    expect(d.stats).toEqual({ health: 50, power: 5, harmony: -3, violence: 100 });
    expect(d.ascended).toBe(false);
  });

  it("reuses the leaderboard record and splits it per tier (tiers sum to the record)", () => {
    const d = details.get("100")!;
    expect(d.record).toMatchObject({ wins: 1, losses: 0, tournaments: 1, bestPlacement: 1, winrate: 1 });
    expect(d.bracketRecord.rookie).toEqual({ wins: 1, losses: 0 });
    expect(d.bracketRecord.veteran).toEqual({ wins: 0, losses: 0 });
    expect(d.bracketRecord.champion).toEqual({ wins: 0, losses: 0 });
    const tierW = d.bracketRecord.rookie.wins + d.bracketRecord.veteran.wins + d.bracketRecord.champion.wins;
    const tierL = d.bracketRecord.rookie.losses + d.bracketRecord.veteran.losses + d.bracketRecord.champion.losses;
    expect(tierW).toBe(d.record.wins);
    expect(tierL).toBe(d.record.losses);
  });

  it("flags ascended state and carries budIndex", () => {
    const d = details.get("200")!;
    expect(d.ascended).toBe(true);
    expect(d.budIndex).toBe(7);
    expect(d.bracketRecord.rookie).toEqual({ wins: 0, losses: 1 });
    expect(d.name).toBe("Taruchi #2"); // unnamed → fallback
  });

  it("zeroes the record for a never-played taru and uses the never-placed sentinel", () => {
    const d = details.get("300")!;
    expect(d.record).toEqual({
      wins: 0,
      losses: 0,
      tournaments: 0,
      bestPlacement: 8,
      winrate: 0,
      qualified: false,
      onyxWon: 0,
      onyxSpent: 0,
    });
    expect(d.bracketRecord).toEqual({
      rookie: { wins: 0, losses: 0 },
      veteran: { wins: 0, losses: 0 },
      champion: { wins: 0, losses: 0 },
    });
    expect(d.ascended).toBe(false);
  });

  // Guard the int16 mask constant the helpers rely on.
  it("uses a 16-bit mask", () => {
    expect(MASK_16).toBe(0xffffn);
  });

  it("splits eight-player festival results into the collapsed tier bucket", () => {
    const festivalCores = Array.from({ length: 8 }, (_, i) => ({
      id: BigInt(1000 + i),
      owner: `0x${String(i + 1).padStart(40, "0")}`,
      index: i + 1,
    }));
    const festivalStatuses = festivalCores.map((core) => status({ id: core.id }));
    const festivalInput: BuildTaruchiDetailsInput = {
      tourneys: [{ id: 77n, status: 2, bracket: 4, players: packU32([1, 2, 3, 4, 5, 6, 7, 8]) }],
      duels: [],
      results: [{ id: 77n, placements: packU32([1, 2, 3, 4, 5, 6, 7, 8]) }],
      cores: festivalCores,
      statuses: festivalStatuses,
      names: [],
      byTaruchi: new Map([
        ["1000", lbRow({ taruchiId: 1000n, taruchiIndex: 1, ownerWallet: festivalCores[0].owner, wins: 3, losses: 0 })],
        ["1007", lbRow({ taruchiId: 1007n, taruchiIndex: 8, ownerWallet: festivalCores[7].owner, wins: 2, losses: 1 })],
      ]),
      spriteFor: (core) => `sprite/${core.index}`,
      decodeName: (s) => s,
    };

    const festivalDetails = buildTaruchiDetails(festivalInput);

    expect(festivalDetails.get("1000")!.bracketRecord).toEqual({
      rookie: { wins: 3, losses: 0 },
      veteran: { wins: 0, losses: 0 },
      champion: { wins: 0, losses: 0 },
    });
    expect(festivalDetails.get("1007")!.bracketRecord).toEqual({
      rookie: { wins: 2, losses: 1 },
      veteran: { wins: 0, losses: 0 },
      champion: { wins: 0, losses: 0 },
    });
  });
});
