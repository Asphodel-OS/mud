/**
 * packUtils — pure pack/unpack utilities for MUD uint256-packed arrays.
 *
 * Mirrors LibPack.sol on the client side. No React or stash dependencies.
 */

/** Pack an array of uint32 values into a uint256. Mirrors LibPack.packArrU32.
 *  Slot[0] is placed in the highest bits (big-endian within the word). */
export function packU32(values: number[]): bigint {
  let result = 0n;
  for (let i = 0; i < Math.min(values.length, 8); i++) {
    result = (result << 32n) | (BigInt(values[i]) & 0xffffffffn);
  }
  // Pad remaining slots with zeros (shift left for any empty slots)
  const remaining = 8 - Math.min(values.length, 8);
  result = result << BigInt(remaining * 32);
  return result;
}

/** Unpack a uint256 into uint32 values. Mirrors LibPack.unpackArrU32.
 *  Always reads all 8 slots (packArrU32 places slot[0] in the highest bits),
 *  then strips trailing zeros. The previous implementation read only `length`
 *  slots from the bottom — correct for 8-element arrays but returned [0,0]
 *  for 2-element duel placements where data lives in the top bits.
 *
 *  Invariant: taruchi indices start at 1; index 0 is the sentinel for
 *  "empty slot". A packed value of 0n therefore means no entries, and
 *  trailing zeros are not truncated real data. */
export function unpackU32(packed: bigint): number[] {
  if (packed === 0n) return [];
  const out: number[] = new Array(8);
  let p = packed;
  for (let i = 0; i < 8; i++) {
    out[7 - i] = Number(p & 0xffffffffn);
    p >>= 32n;
  }
  // Strip trailing zeros
  let len = 8;
  while (len > 0 && out[len - 1] === 0) len--;
  return out.slice(0, len);
}
