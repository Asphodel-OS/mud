import { describe, it, expect } from "vitest";
import { concatHex, numberToHex, type Hex } from "viem";
import type { StorageAdapterLog } from "@latticexyz/store-sync";
import { keyToId, readStaticUint, setRecordsFor } from "./supabasePush";

const TABLE_A = `0x${"a".repeat(64)}` as Hex;
const TABLE_B = `0x${"b".repeat(64)}` as Hex;

function setRecord(tableId: Hex, id: bigint, staticData: Hex): StorageAdapterLog {
  return {
    eventName: "Store_SetRecord",
    args: { tableId, keyTuple: [numberToHex(id, { size: 32 })], staticData },
  } as unknown as StorageAdapterLog;
}

function spliceLog(tableId: Hex): StorageAdapterLog {
  return { eventName: "Store_SpliceStaticData", args: { tableId } } as unknown as StorageAdapterLog;
}

describe("setRecordsFor", () => {
  it("returns only Store_SetRecord logs for the requested table", () => {
    const logs = [
      setRecord(TABLE_A, 1n, "0x00"),
      setRecord(TABLE_B, 2n, "0x00"),
      spliceLog(TABLE_A), // not a SetRecord → ignored
      setRecord(TABLE_A, 3n, "0x00"),
    ];
    const recs = setRecordsFor(logs, TABLE_A);
    expect(recs.map((r) => keyToId(r))).toEqual(["1", "3"]);
  });

  it("is empty when nothing matches", () => {
    expect(setRecordsFor([spliceLog(TABLE_A)], TABLE_A)).toEqual([]);
  });
});

describe("keyToId", () => {
  it("renders the first key field as a decimal string (matches uint256 id::text)", () => {
    expect(keyToId(setRecordsFor([setRecord(TABLE_A, 123456789n, "0x00")], TABLE_A)[0])).toBe("123456789");
  });
});

describe("readStaticUint", () => {
  it("reads a uint field at a byte offset", () => {
    // [u256 @0][u8=5 @32][u32=1700000000 @33]
    const staticData = concatHex([
      numberToHex(0n, { size: 32 }),
      numberToHex(5, { size: 1 }),
      numberToHex(1_700_000_000, { size: 4 }),
    ]);
    expect(readStaticUint(staticData, 32, 1)).toBe(5);
    expect(readStaticUint(staticData, 33, 4)).toBe(1_700_000_000);
  });
});
