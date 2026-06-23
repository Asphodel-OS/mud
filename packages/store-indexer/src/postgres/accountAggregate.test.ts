import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { buildAccountAggregate } from "./accountAggregate";

const OWNER_A = "0x00000000000000000000000000000000000000aA";
const OWNER_B = "0x00000000000000000000000000000000000000bB";
const REFERRER = "0x000000000000000000000000000000000000bEEF";

describe("buildAccountAggregate", () => {
  it("indexes account rows by owner and derives referral counts", () => {
    const aggregate = buildAccountAggregate([
      { owner: OWNER_A, index: 1, referrer: REFERRER, createdBlock: "100" },
      { owner: OWNER_B, index: 2, referrer: REFERRER, createdBlock: 120n },
    ]);

    expect(aggregate.accountByOwner.get(OWNER_A.toLowerCase())).toEqual({
      index: 1,
      referrer: REFERRER.toLowerCase(),
      createdBlock: "100",
    });
    expect(aggregate.accountByOwner.get(OWNER_B.toLowerCase())?.createdBlock).toBe("120");
    expect(aggregate.referralCountByReferrer.get(REFERRER.toLowerCase())).toBe(2);
  });

  it("stores zero referrers as null and does not count them", () => {
    const aggregate = buildAccountAggregate([{ owner: OWNER_A, index: 1, referrer: zeroAddress, createdBlock: "100" }]);

    expect(aggregate.accountByOwner.get(OWNER_A.toLowerCase())?.referrer).toBeNull();
    expect(aggregate.referralCountByReferrer.size).toBe(0);
  });

  it("skips invalid or unset account rows", () => {
    const aggregate = buildAccountAggregate([
      { owner: null, index: 1, referrer: REFERRER, createdBlock: "100" },
      { owner: OWNER_A, index: 0, referrer: REFERRER, createdBlock: "100" },
      { owner: OWNER_B, index: "not-a-number", referrer: REFERRER, createdBlock: "100" },
    ]);

    expect(aggregate.accountByOwner.size).toBe(0);
    expect(aggregate.referralCountByReferrer.size).toBe(0);
  });
});
