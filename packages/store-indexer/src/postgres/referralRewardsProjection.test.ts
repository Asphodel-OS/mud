import { describe, expect, it, vi } from "vitest";
import { numberToHex, type Hex } from "viem";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import {
  buildReferralRewardsByReferrer,
  collectReferralRewardDeltas,
  findClaimableExceedingLifetime,
  REFERRAL_REWARDS_TABLE_ID,
  type ReferralRewardProjectionRow,
} from "./referralRewardsProjection";

vi.mock("@latticexyz/store-sync/postgres", (): { transformSchemaName: (name: string) => string } => ({
  transformSchemaName: (name: string): string => name,
}));

const REFERRER = "0x000000000000000000000000000000000000bEEF";
const OTHER_REFERRER = "0x000000000000000000000000000000000000cAFE";

function key(address: string): Hex {
  return numberToHex(BigInt(address), { size: 32 });
}

function splice(referrer: string, claimable: bigint, logIndex: number): StorageAdapterLog {
  return {
    eventName: "Store_SpliceStaticData",
    logIndex,
    args: {
      tableId: REFERRAL_REWARDS_TABLE_ID,
      keyTuple: [key(referrer)],
      start: 0,
      data: numberToHex(claimable, { size: 32 }),
    },
  } as unknown as StorageAdapterLog;
}

function setRecord(referrer: string, claimable: bigint, logIndex: number): StorageAdapterLog {
  return {
    eventName: "Store_SetRecord",
    logIndex,
    args: {
      tableId: REFERRAL_REWARDS_TABLE_ID,
      keyTuple: [key(referrer)],
      staticData: numberToHex(claimable, { size: 32 }),
    },
  } as unknown as StorageAdapterLog;
}

describe("collectReferralRewardDeltas", () => {
  it("emits only positive claimable deltas and keeps claim resets out of lifetime", () => {
    const initial = new Map([[REFERRER.toLowerCase(), 1_000n]]);
    const { deltas, nextClaimableByReferrer } = collectReferralRewardDeltas(
      [splice(REFERRER, 1_330n, 7), splice(REFERRER, 1_430n, 8), splice(REFERRER, 0n, 9), splice(REFERRER, 100n, 10)],
      123n,
      initial,
    );

    expect(deltas.map((delta) => delta.amountOnyxWei)).toEqual([330n, 100n, 100n]);
    expect(deltas.map((delta) => delta.logIndex)).toEqual([7, 8, 10]);
    expect(nextClaimableByReferrer.get(REFERRER.toLowerCase())).toBe(100n);
  });

  it("handles full record writes and separate referrers independently", () => {
    const { deltas, nextClaimableByReferrer } = collectReferralRewardDeltas(
      [setRecord(REFERRER, 330n, 1), setRecord(OTHER_REFERRER, 500n, 2)],
      124n,
      new Map(),
    );

    expect(deltas.map((delta) => [delta.referrer, delta.amountOnyxWei])).toEqual([
      [REFERRER.toLowerCase(), 330n],
      [OTHER_REFERRER.toLowerCase(), 500n],
    ]);
    expect(nextClaimableByReferrer.get(OTHER_REFERRER.toLowerCase())).toBe(500n);
  });

  it("ignores other tables and partial static splices", () => {
    const otherTable = `0x${"a".repeat(64)}` as Hex;
    const logs = [
      { eventName: "Store_SpliceStaticData", args: { tableId: otherTable, keyTuple: [key(REFERRER)], start: 0 } },
      {
        eventName: "Store_SpliceStaticData",
        args: { tableId: REFERRAL_REWARDS_TABLE_ID, keyTuple: [key(REFERRER)], start: 1 },
      },
    ] as unknown as StorageAdapterLog[];

    const { deltas } = collectReferralRewardDeltas(logs, 125n, new Map());

    expect(deltas).toEqual([]);
  });
});

describe("buildReferralRewardsByReferrer", () => {
  it("normalizes valid rows and skips invalid addresses", () => {
    const rewards = buildReferralRewardsByReferrer([
      { referrer: REFERRER, claimableOnyxWei: "330", lifetimeEarnedOnyxWei: "1330" },
      { referrer: "not-an-address", claimableOnyxWei: "1", lifetimeEarnedOnyxWei: "1" },
    ]);

    expect(rewards.get(REFERRER.toLowerCase())).toEqual({
      claimableOnyxWei: "330",
      lifetimeEarnedOnyxWei: "1330",
    });
    expect(rewards.size).toBe(1);
  });
});

describe("findClaimableExceedingLifetime", () => {
  const rows = (entries: Array<[string, string, string]>): ReferralRewardProjectionRow[] =>
    entries.map(([referrer, claimableOnyxWei, lifetimeEarnedOnyxWei]) => ({
      referrer,
      claimableOnyxWei,
      lifetimeEarnedOnyxWei,
    }));

  it("flags only referrers whose claimable exceeds lifetime", () => {
    const offending = findClaimableExceedingLifetime(
      rows([
        [REFERRER, "500", "330"], // claimable > lifetime → corrupted ledger
        [OTHER_REFERRER, "330", "330"], // equal → healthy
        ["0x000000000000000000000000000000000000dEaD", "0", "1000"], // claimed out → healthy
      ]),
    );

    expect(offending.map((row) => row.referrer)).toEqual([REFERRER]);
  });

  it("returns nothing when every row is healthy", () => {
    expect(findClaimableExceedingLifetime(rows([[REFERRER, "100", "100"]]))).toEqual([]);
  });

  it("ignores rows with malformed numerics", () => {
    expect(findClaimableExceedingLifetime(rows([[REFERRER, "oops", "0"]]))).toEqual([]);
  });
});
