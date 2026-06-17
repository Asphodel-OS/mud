import { describe, it, expect } from "vitest";
import { packU32 } from "./packUtils";
import {
  buildAggregate,
  type TourneyLike,
  type DuelLike,
  type ResultLike,
  type CoreLike,
  type StatusLike,
} from "./buildAggregate";

function mkCore(id: bigint, owner: string, index: number): CoreLike {
  return { id, owner, index };
}
function mkStatus(id: bigint, state: number, level = 33, affinity = 0): StatusLike {
  return { id, state, level, affinity, traits: 0n };
}
function mkResult(id: bigint, winnerIndex: number, loserIndex: number): ResultLike {
  return { id, placements: packU32([winnerIndex, loserIndex]) };
}
function mkDuel(id: bigint, bracket: number, a: number, b: number, status = 2): DuelLike {
  return { id, bracket, status, playerAIndex: a, playerBIndex: b };
}

const decodeName = (n: string): string => n;
const spriteFor = (): string => "/images/taruchi/taruchi_silhouette_shadow.png";

describe("buildAggregate", () => {
  it("returns empty aggregate when no data", () => {
    const out = buildAggregate({
      tourneys: [],
      duels: [],
      results: [],
      cores: [],
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });
    expect(out.overall).toEqual([]);
    expect(out.byWallet.size).toBe(0);
    expect(out.ascended).toEqual([]);
    expect(out.recordCount).toBe(0);
  });

  it("aggregates a single duel win into overall", () => {
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)]; // 10 wins

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    expect(out.overall).toHaveLength(2);
    expect(out.overall[0].wallet).toBe("0xaaa");
    expect(out.overall[0].wins).toBe(1);
    expect(out.overall[0].festivalWins).toBe(0);
    expect(out.overall[1].wallet).toBe("0xbbb");
    expect(out.overall[1].wins).toBe(0);
    expect(out.overall[1].festivalWins).toBe(0);
    // bestPlacement is a festival-podium stat: duels must NOT set it, so both
    // duel-only players stay at the never-placed sentinel (8).
    expect(out.overall[0].bestPlacement).toBe(8);
    expect(out.overall[1].bestPlacement).toBe(8);
  });

  it("collapses rookie duel + rookie festival wins into one row per wallet", () => {
    // Same wallet (0x00a, index 10) wins both a rookie duel (bracket 1) and a rookie festival (bracket 4).
    const players = packU32([10, 20, 30, 40, 50, 60, 70, 80]);
    const tourneys: TourneyLike[] = [{ id: 200n, status: 2, bracket: 4, players }];
    const results: ResultLike[] = [
      { id: 200n, placements: packU32([10, 40, 30, 60, 70, 80, 20, 50]) }, // festival: 10 wins
      mkResult(300n, 10, 20), // duel: 10 beats 20
    ];
    const duels = [mkDuel(300n, 1, 10, 20)];
    const cores = [10, 20, 30, 40, 50, 60, 70, 80].map((i, n) =>
      mkCore(BigInt(n + 1), `0x${i.toString(16).padStart(3, "0")}`, i),
    );

    const out = buildAggregate({
      tourneys,
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const winnerRows = out.overall.filter((r) => r.wallet === "0x00a");
    expect(winnerRows).toHaveLength(1); // collapsed, not fragmented
    const winner = winnerRows[0];
    // festival: placementToWins(1) = 3, duel: 1 → total 4 wins
    expect(winner.wins).toBe(4);
    expect(winner.tournaments).toBe(2);
    expect(winner.festivalWins).toBe(1);
  });

  it("increments festivalWins on bracket-4 tourney win (rookie festival)", () => {
    const players = packU32([10, 20, 30, 40, 50, 60, 70, 80]);
    const tourneys: TourneyLike[] = [{ id: 200n, status: 2, bracket: 4, players }];
    const results: ResultLike[] = [{ id: 200n, placements: packU32([10, 40, 30, 60, 70, 80, 20, 50]) }];
    const cores = [10, 20, 30, 40, 50, 60, 70, 80].map((i, n) =>
      mkCore(BigInt(n + 1), `0x${i.toString(16).padStart(3, "0")}`, i),
    );

    const out = buildAggregate({
      tourneys,
      duels: [],
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const winner = out.overall.find((r) => r.wallet === "0x00a")!;
    const loser = out.overall.find((r) => r.wallet === "0x014")!; // index 20 → 0x014
    expect(winner.festivalWins).toBe(1);
    expect(loser.festivalWins).toBe(0);
  });

  it("duel win does NOT increment festivalWins", () => {
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)];

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const winner = out.overall.find((r) => r.wallet === "0xaaa")!;
    expect(winner.wins).toBe(1);
    expect(winner.festivalWins).toBe(0);
  });

  it("byWallet row is reference-identical to the overall entry", () => {
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)];
    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });
    const fromOverall = out.overall.find((r) => r.wallet === "0xaaa");
    const fromWallet = out.byWallet.get("0xaaa");
    expect(fromOverall).toBe(fromWallet);
  });

  it("duels are free: no ONYX spent or won by either side", () => {
    // Duel, bracket=1 (rookie). Duels cost 0 ONYX: no entry, no prize.
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)];

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const winner = out.overall.find((r) => r.wallet === "0xaaa")!;
    const loser = out.overall.find((r) => r.wallet === "0xbbb")!;
    expect(winner.onyxWon).toBe(0);
    expect(winner.onyxSpent).toBe(0);
    expect(loser.onyxWon).toBe(0);
    expect(loser.onyxSpent).toBe(0);
  });

  it("aggregates festival diagram placements correctly (L11 placement-3 = 9 ONYX)", () => {
    // Rookie festival (bracket=4, entry=5 ONYX). Diagram placement 3 pays 9 ONYX.
    // Wallet 0x00a takes 3rd → gross 9, cost 5 entry, net +4.
    const players = packU32([10, 20, 30, 40, 50, 60, 70, 80]);
    const tourneys: TourneyLike[] = [{ id: 200n, status: 2, bracket: 4, players }];
    // Place 10 at position 3 → placement 3 → diagram L11 3rd = 9 ONYX
    const results: ResultLike[] = [{ id: 200n, placements: packU32([20, 40, 30, 10, 70, 80, 60, 50]) }];
    const cores = [10, 20, 30, 40, 50, 60, 70, 80].map((i, n) =>
      mkCore(BigInt(n + 1), `0x${i.toString(16).padStart(3, "0")}`, i),
    );

    const out = buildAggregate({
      tourneys,
      duels: [],
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const row = out.overall.find((r) => r.wallet === "0x00a")!;
    expect(row.onyxSpent).toBe(5);
    expect(row.onyxWon).toBe(4); // 9 gross − 5 entry
  });

  it("aggregates per-taru rows alongside per-wallet", () => {
    // Same owner owns two tarus (indices 10, 20). Each wins its own duel.
    // Wallet row collapses to 2 wins; per-taru rows each show 1 win.
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xAAA", 20), mkCore(3n, "0xBBB", 30), mkCore(4n, "0xCCC", 40)];
    const duels = [mkDuel(100n, 1, 10, 30), mkDuel(101n, 1, 20, 40)];
    const results = [mkResult(100n, 10, 30), mkResult(101n, 20, 40)];

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const walletRow = out.overall.find((r) => r.wallet === "0xaaa")!;
    expect(walletRow.wins).toBe(2);

    expect(out.overallByTaruchi).toHaveLength(4); // 10, 20, 30, 40
    const taru10 = out.byTaruchi.get("1")!;
    const taru20 = out.byTaruchi.get("2")!;
    expect(taru10.wins).toBe(1);
    expect(taru10.taruchiIndex).toBe(10);
    expect(taru10.ownerWallet).toBe("0xaaa");
    expect(taru20.wins).toBe(1);
    expect(taru20.taruchiIndex).toBe(20);
  });

  it("skips unrevealed tarus in per-taru output", () => {
    // Taru at index 10 has state=0 (UNREVEALED) — shouldn't accumulate even if
    // a stray result pointed to it. Real contract enforces state prereqs, so
    // this is a defensive filter check.
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const statuses = [mkStatus(1n, 0), mkStatus(2n, 1)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)];

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses,
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    // Only taru 20 surfaces in per-taru output; 10 is filtered as unrevealed.
    expect(out.overallByTaruchi.map((r) => r.taruchiIndex).sort()).toEqual([20]);
    // Wallet aggregate unaffected — it doesn't apply the state filter.
    expect(out.overall.find((r) => r.wallet === "0xaaa")?.wins).toBe(1);
  });

  it("includes dead and ascended tarus in per-taru output", () => {
    // Legacy champions: state=5 (DEAD) and state=4 (ASCENDED) still rank.
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const statuses = [mkStatus(1n, 5 /* DEAD */), mkStatus(2n, 4 /* ASCENDED */)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)]; // 10 wins

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses,
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    expect(out.overallByTaruchi).toHaveLength(2);
    const dead = out.byTaruchi.get("1")!;
    const ascended = out.byTaruchi.get("2")!;
    expect(dead.state).toBe(5);
    expect(dead.wins).toBe(1);
    expect(ascended.state).toBe(4);
    expect(ascended.wins).toBe(0);
  });

  it("per-taru onyx net equals wallet net when wallet owns one taru", () => {
    // Single-taru wallet: every wallet-level number is attributable to that
    // one taru, so the two nets must match to the cent.
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const duels = [mkDuel(100n, 1, 10, 20)];
    const results = [mkResult(100n, 10, 20)];

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const walletRow = out.overall.find((r) => r.wallet === "0xaaa")!;
    const taruRow = out.byTaruchi.get("1")!;
    expect(taruRow.onyxWon).toBe(walletRow.onyxWon);
    expect(taruRow.onyxSpent).toBe(walletRow.onyxSpent);
  });

  it("includes ASCENDED taruchis in ascended array", () => {
    const cores = [mkCore(1n, "0xAAA", 10), mkCore(2n, "0xBBB", 20)];
    const statuses = [mkStatus(1n, 4 /* ASCENDED */), mkStatus(2n, 1 /* IDLE */)];
    const out = buildAggregate({
      tourneys: [],
      duels: [],
      results: [],
      cores,
      statuses,
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });
    expect(out.ascended).toHaveLength(1);
    expect(out.ascended[0].wallet).toBe("0xaaa");
    expect(out.ascended[0].taruchiIndex).toBe(10);
  });

  it("rankings screenshot scenario: 9-1 displays as 90% (not bayesian 79%), 5-0 rookie sorted below qualified rows", () => {
    // Recreates the bug from the rankings screenshot:
    //   Ron Snow: 9W-1L was rendering as 79% (bayesian-shrunk) instead of 90%
    //   Conguito: 11W-2L rendered 76% instead of ~85%
    // Plus a 5-0 rookie who must NOT outrank the qualified players despite raw 100%.
    const aCore = mkCore(1n, "0xAAA", 1); // ron snow analogue (9-1)
    const bCore = mkCore(2n, "0xBBB", 2); // conguito analogue (11-2)
    const rookieCore = mkCore(3n, "0xCCC", 3); // 5-0 rookie — should NOT take #1

    // Punching-bag opponents for each match; using distinct fillers keeps
    // every duel between two different wallets so no filler accidentally
    // qualifies into the leaderboard's qualified band.
    const fillerCores = Array.from({ length: 60 }, (_, i) =>
      mkCore(BigInt(100 + i), `0xF${i.toString(16).padStart(2, "0")}`, 100 + i),
    );
    const cores = [aCore, bCore, rookieCore, ...fillerCores];

    let nextDuelId = 1000n;
    let fillerIdx = 0;
    const duels: DuelLike[] = [];
    const results: ResultLike[] = [];
    const addDuel = (winnerIdx: number, loserIdx: number): void => {
      duels.push(mkDuel(nextDuelId, 1, winnerIdx, loserIdx));
      results.push(mkResult(nextDuelId, winnerIdx, loserIdx));
      nextDuelId += 1n;
    };

    // A: 9 wins, 1 loss
    for (let i = 0; i < 9; i++) addDuel(aCore.index, fillerCores[fillerIdx++].index);
    addDuel(fillerCores[fillerIdx++].index, aCore.index);
    // B: 11 wins, 2 losses
    for (let i = 0; i < 11; i++) addDuel(bCore.index, fillerCores[fillerIdx++].index);
    for (let i = 0; i < 2; i++) addDuel(fillerCores[fillerIdx++].index, bCore.index);
    // Rookie: 5 wins, 0 losses
    for (let i = 0; i < 5; i++) addDuel(rookieCore.index, fillerCores[fillerIdx++].index);

    const out = buildAggregate({
      tourneys: [],
      duels,
      results,
      cores,
      statuses: [],
      names: [],
      protocolFeeBps: 0n,
      festivalProtocolFeeBps: 0n,
      jackpotBps: 0n,
      spriteFor,
      decodeName,
    });

    const a = out.overall.find((r) => r.wallet === "0xaaa")!;
    const b = out.overall.find((r) => r.wallet === "0xbbb")!;
    const rookie = out.overall.find((r) => r.wallet === "0xccc")!;

    // Raw rates — no bayesian shrinkage.
    expect(a.wins).toBe(9);
    expect(a.losses).toBe(1);
    expect(a.winrate).toBeCloseTo(0.9, 3); // 9/10 — was reading 0.786 under bayesian
    expect(a.qualified).toBe(true); // 10 battles, hits threshold

    expect(b.wins).toBe(11);
    expect(b.losses).toBe(2);
    expect(b.winrate).toBeCloseTo(11 / 13, 3); // 0.846 raw — was reading 0.765 under bayesian
    expect(b.qualified).toBe(true);

    expect(rookie.wins).toBe(5);
    expect(rookie.losses).toBe(0);
    expect(rookie.winrate).toBe(1); // 100% raw, but...
    expect(rookie.qualified).toBe(false); // ...gated out by min-games

    // Sort order: qualified rows must appear ahead of the rookie despite
    // the rookie's perfect raw rate. A (90%) beats B (84.6%).
    const aIdx = out.overall.findIndex((r) => r.wallet === "0xaaa");
    const bIdx = out.overall.findIndex((r) => r.wallet === "0xbbb");
    const rookieIdx = out.overall.findIndex((r) => r.wallet === "0xccc");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(rookieIdx);
  });
});
