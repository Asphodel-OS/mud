import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address } from "viem";
import { EMPTY_AGGREGATE, type LeaderboardAggregate } from "../leaderboard/types";
import {
  buildAscensionRecordTypedData,
  isIndexerCaughtUp,
  lookupAscensionRecord,
  parseTaruchiIdParam,
  signAscensionRecord,
} from "./ascensionRecordAttestation";

const worldAddress = "0x000000000000000000000000000000000000beef" as Address;
const signer = privateKeyToAccount("0x000000000000000000000000000000000000000000000000000000000000a5ce");

function aggregateWithAscended(row?: { wins: number; losses: number }): LeaderboardAggregate {
  const taruchiId = 11n;
  return {
    ...EMPTY_AGGREGATE,
    byTaruchi: row
      ? new Map([
          [
            taruchiId.toString(),
            {
              taruchiId,
              taruchiIndex: 11,
              ownerWallet: "0xabc",
              name: "Taruchi #11",
              state: 4,
              imageUrl: "/t.png",
              wins: row.wins,
              losses: row.losses,
              tournaments: 1,
              bestPlacement: 1,
              winrate: 1,
              qualified: false,
              onyxWon: 0,
              onyxSpent: 0,
            },
          ],
        ])
      : new Map(),
    ascended: [
      {
        taruchiId,
        taruchiIndex: 11,
        wallet: "0xabc",
        name: "Taruchi #11",
        affinity: "Normal",
        ascendedAt: 0,
        imageUrl: "/t.png",
      },
    ],
  };
}

describe("ascensionRecordAttestation", () => {
  it("parses decimal taruchi ids only", () => {
    expect(parseTaruchiIdParam("123")).toBe(123n);
    expect(parseTaruchiIdParam("0x7b")).toBeNull();
    expect(parseTaruchiIdParam("../123")).toBeNull();
  });

  it("checks indexed block freshness against RPC head", () => {
    expect(isIndexerCaughtUp(100n, 100n, 0n)).toBe(true);
    expect(isIndexerCaughtUp(99n, 100n, 0n)).toBe(false);
    expect(isIndexerCaughtUp(99n, 100n, 1n)).toBe(true);
  });

  it("returns the per-taruchi leaderboard record for ascended tarus", () => {
    const lookup = lookupAscensionRecord(aggregateWithAscended({ wins: 7, losses: 2 }), 11n, 1);
    expect(lookup).toEqual({ status: "ok", record: { taruchiId: 11n, wins: 7, losses: 2 } });
  });

  it("refuses to sign missing records on non-local chains", () => {
    expect(lookupAscensionRecord(aggregateWithAscended(), 11n, 1)).toEqual({ status: "record-missing" });
  });

  it("allows a zero record for local dev ascensions", () => {
    expect(lookupAscensionRecord(aggregateWithAscended(), 11n, 31337)).toEqual({
      status: "ok",
      record: { taruchiId: 11n, wins: 0, losses: 0 },
    });
  });

  it("signs typed data recoverable to the configured signer", async () => {
    const record = { taruchiId: 11n, wins: 7, losses: 2 };
    const deadline = 1_800_000_000n;
    const signature = await signAscensionRecord({
      signer,
      chainId: 31337,
      worldAddress,
      record,
      deadline,
    });
    const recovered = await recoverTypedDataAddress({
      ...buildAscensionRecordTypedData({
        chainId: 31337,
        worldAddress,
        taruchiId: record.taruchiId,
        wins: record.wins,
        losses: record.losses,
        deadline,
      }),
      signature,
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });
});
