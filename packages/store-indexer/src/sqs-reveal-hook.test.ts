import { describe, it, expect } from "vitest";
import { unpackTraits } from "./sqs-reveal-hook";

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
