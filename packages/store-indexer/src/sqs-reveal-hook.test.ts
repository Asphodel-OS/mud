import { describe, it, expect } from "vitest";
import { unpackTraits, extractRevealCodes } from "./sqs-reveal-hook";
import { resourceToHex } from "@latticexyz/common";
import { StorageAdapterLog } from "@latticexyz/store-sync";

const TARUCHI_STATUS_TABLE_ID = resourceToHex({
  type: "table",
  namespace: "app",
  name: "TaruchiStatus",
});

describe("unpackTraits", () => {
  it("decodes packed uint40 traits into BBEEMMEEFF code", () => {
    // traits = flower | body<<8 | eye<<16 | mouth<<24 | equipment<<32
    // body=1, eye=3, mouth=5, equipment=2, flower=1
    const traits = 1n | (1n << 8n) | (3n << 16n) | (5n << 24n) | (2n << 32n);
    expect(unpackTraits(traits)).toBe("0103050201");
  });

  it("handles zero flower and equipment", () => {
    // body=12, eye=5, mouth=3, equipment=0, flower=0
    const traits = (3n << 24n) | (5n << 16n) | (12n << 8n);
    expect(unpackTraits(traits)).toBe("1205030000");
  });

  it("handles max values", () => {
    // body=24, eye=9, mouth=7, equipment=26, flower=11
    const traits = (26n << 32n) | (7n << 24n) | (9n << 16n) | (24n << 8n) | 11n;
    expect(unpackTraits(traits)).toBe("2409072611");
  });
});

describe("extractRevealCodes", () => {
  const makeLog = (eventName: string, tableId: string, staticData: string): StorageAdapterLog =>
    ({
      eventName,
      address: "0x0000000000000000000000000000000000000001" as const,
      args: {
        tableId,
        keyTuple: ["0x0000000000000000000000000000000000000000000000000000000000000001"] as const,
        staticData,
        encodedLengths: "0x" as const,
        dynamicData: "0x" as const,
      },
    }) as unknown as StorageAdapterLog;

  it("extracts code from a reveal log (state=IDLE)", () => {
    // TaruchiStatus static layout: affinity(1) + state(1) + level(4) + xp(4) + tp(4) + traits(5) = 19 bytes
    // traits packed as uint40: flower | body<<8 | eye<<16 | mouth<<24 | equipment<<32
    // body=1,eye=3,mouth=5,equip=2,flower=1 -> big-endian uint40 = 0x0205030101
    const staticData =
      "0x" +
      "03" + // affinity: 3
      "01" + // state: 1 (IDLE)
      "00000001" + // level: 1
      "00000000" + // xp: 0
      "00000000" + // trainingPoints: 0
      "0205030101"; // traits: body=1,eye=3,mouth=5,equip=2,flower=1

    const logs = [makeLog("Store_SetRecord", TARUCHI_STATUS_TABLE_ID, staticData)];
    const codes = extractRevealCodes(logs);
    expect(codes).toEqual(["0103050201"]);
  });

  it("ignores non-SetRecord events", () => {
    const staticData = "0x" + "03" + "01" + "00000001" + "00000000" + "00000000" + "0205030101";
    const logs = [makeLog("Store_DeleteRecord", TARUCHI_STATUS_TABLE_ID, staticData)];
    expect(extractRevealCodes(logs)).toEqual([]);
  });

  it("ignores wrong table ID", () => {
    const otherTableId = resourceToHex({ type: "table", namespace: "app", name: "TaruchiCore" });
    const staticData = "0x" + "03" + "01" + "00000001" + "00000000" + "00000000" + "0205030101";
    const logs = [makeLog("Store_SetRecord", otherTableId, staticData)];
    expect(extractRevealCodes(logs)).toEqual([]);
  });

  it("ignores non-IDLE state", () => {
    // state=2 (ENROLLED)
    const staticData = "0x" + "03" + "02" + "00000001" + "00000000" + "00000000" + "0205030101";
    const logs = [makeLog("Store_SetRecord", TARUCHI_STATUS_TABLE_ID, staticData)];
    expect(extractRevealCodes(logs)).toEqual([]);
  });

  it("extracts multiple reveals from one block", () => {
    const staticData1 = "0x" + "03" + "01" + "00000001" + "00000000" + "00000000" + "0205030101";
    // body=12,eye=5,mouth=3,equip=0,flower=0 -> uint40 = 0x0003050c00
    const staticData2 = "0x" + "05" + "01" + "00000001" + "00000000" + "00000000" + "0003050c00";
    const logs = [
      makeLog("Store_SetRecord", TARUCHI_STATUS_TABLE_ID, staticData1),
      makeLog("Store_SetRecord", TARUCHI_STATUS_TABLE_ID, staticData2),
    ];
    const codes = extractRevealCodes(logs);
    expect(codes).toEqual(["0103050201", "1205030000"]);
  });
});
