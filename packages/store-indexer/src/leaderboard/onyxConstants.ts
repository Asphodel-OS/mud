/**
 * Client-side ONYX chain constants — must stay aligned with
 * `packages/contracts/src/namespaces/app/libraries/LibOnyx.sol` (compile-time)
 * and the `onyx.jackpotBalance` Config key for live balance reads.
 */

import { keccak256, encodePacked, parseEther } from "viem";

/** Canonical ONYX ERC-20 (same as `LibOnyx.ONYX_TOKEN`). */
export const ONYX_TOKEN_ADDRESS = "0x2a4e393098656fbC850564aAF30cc5DB76B3e9f7" as const;

/** Team / protocol fee recipient (same as `LibOnyx.TEAM_WALLET`). */
export const ONYX_TEAM_WALLET_ADDRESS = "0x3d7f111B3b69C657624b8633a997A56300212872" as const;

// Basis points — mirrors LibOnyx file-level constants (GDD §10.1). Redeploy to change.

/** Duel protocol fee: 5% (95% to winner). */
export const ONYX_PROTOCOL_FEE_BPS = 500n;
/** Festival protocol fee: 10% (80% to winners after the 10% jackpot accrual). */
export const ONYX_FESTIVAL_PROTOCOL_FEE_BPS = 1000n;
/** Jackpot accrual from 8-player tourney/festival entry pools only (duels use 0 on-chain). */
export const ONYX_TOURNEY_JACKPOT_BPS = 1000n;
/** L33 ascension payout rate — 10% per GDD §10.1. */
export const ONYX_JACKPOT_PAYOUT_BPS = 1000n;

// Festival placement payouts — hardcoded per money-flows diagram (ECONOMY.md §4.3).
// Each amount = entry-pool prize share + Stage Payout bonus share, paid as one transfer.
// L11 totals 57 ONYX (entry 32 + bonus 25), L22 totals 114 (entry 64 + bonus 50),
// L33 totals 152 WTA (entry 96 + bonus 56) plus the 10%-of-jackpot tail.

export const ONYX_L11_PRIZE_1ST = parseEther("24");
export const ONYX_L11_PRIZE_2ND = parseEther("15");
export const ONYX_L11_PRIZE_3RD = parseEther("9");
export const ONYX_L11_PRIZE_4TH = parseEther("9");

export const ONYX_L22_PRIZE_1ST = parseEther("69");
export const ONYX_L22_PRIZE_2ND = parseEther("27");
export const ONYX_L22_PRIZE_3RD = parseEther("9");
export const ONYX_L22_PRIZE_4TH = parseEther("9");

export const ONYX_L33_PRIZE_1ST = parseEther("152");

// Mint / reroll costs — mirror `MINT_COST` and `REROLL_COST` in
// packages/contracts/src/namespaces/app/libraries/Taruchi.sol. Whole
// ONYX units (no parseEther wrapping) so they compare directly to the
// `balance` returned by `useOnyxBalance`, which is also `Number(rawWei / 1e18)`.

/** Mint cost in whole ONYX (Taruchi.sol: `MINT_COST = 9 ether`). */
export const MINT_COST_ONYX = 9;
/** Reroll cost in whole ONYX (Taruchi.sol: `REROLL_COST = 3 ether`). */
export const REROLL_COST_ONYX = 3;
/** Mint cost in wei (`MINT_COST_ONYX * 1e18`) for onchain comparisons
 *  (allowance, raw balance, parseEther-shaped values). */
export const MINT_COST_ONYX_WEI = parseEther(`${MINT_COST_ONYX}`);
/** Reroll cost in wei. */
export const REROLL_COST_ONYX_WEI = parseEther(`${REROLL_COST_ONYX}`);

/** MUD Config row key for `onyx.jackpotBalance` (dynamic on-chain balance). */
export const CONFIG_KEY_JACKPOT_BALANCE = keccak256(
  encodePacked(["string", "string"], ["is.config", "onyx.jackpotBalance"]),
) as `0x${string}`;
