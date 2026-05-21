// Affinity type + ordered list, copied from game2
// `packages/client/src/types/taruchi.ts` (the only thing the leaderboard
// closure needs from that module). game2 is the source of truth — see README.md.

export type Affinity = "Eerie" | "Insect" | "Scrap" | "Normal" | "Metal" | "Stone" | "Wood" | "Elemental";

/** All 8 affinity types in MUD enum order (index = onchain uint8 value). */
export const AFFINITIES: Affinity[] = ["Eerie", "Insect", "Scrap", "Normal", "Metal", "Stone", "Wood", "Elemental"];
