import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { LeaderboardAggregate } from "../leaderboard/types";

export const ASCENSION_RECORD_TYPES = {
  AscensionRecord: [
    { name: "taruchiID", type: "uint256" },
    { name: "claimant", type: "address" },
    { name: "recipient", type: "address" },
    { name: "wins", type: "uint32" },
    { name: "losses", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export type AscensionRecord = {
  taruchiId: bigint;
  claimant: Address;
  recipient: Address;
  wins: number;
  losses: number;
};

export type AscensionRecordLookup =
  | { status: "ok"; record: AscensionRecord }
  | { status: "not-ascended" }
  | { status: "record-missing" }
  | { status: "claimant-mismatch"; owner: string; claimant: Address }
  | { status: "record-out-of-range"; wins: number; losses: number };

export function isIndexerCaughtUp(indexedBlock: bigint, headBlock: bigint, maxLagBlocks: bigint): boolean {
  return indexedBlock + maxLagBlocks >= headBlock;
}

export function parseTaruchiIdParam(raw: string | undefined): bigint | null {
  if (!raw || !/^[0-9]+$/.test(raw)) return null;
  return BigInt(raw);
}

export function parseClaimantParam(raw: string | undefined): Address | null {
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw);
}

export function parseRecipientParam(raw: string | undefined): Address | null {
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw);
}

export function lookupAscensionRecord(
  aggregate: LeaderboardAggregate,
  taruchiId: bigint,
  chainId: number,
  claimant: Address,
  recipient: Address,
): AscensionRecordLookup {
  const taruchiKey = taruchiId.toString();
  const ascended = aggregate.ascended.find((row) => row.taruchiId === taruchiId);
  if (!ascended) return { status: "not-ascended" };

  const row = aggregate.byTaruchi.get(taruchiKey);
  const wins = row?.wins ?? 0;
  const losses = row?.losses ?? 0;

  if (!row && chainId !== 31337) return { status: "record-missing" };
  const owner = (row?.ownerWallet ?? ascended.wallet).toLowerCase();
  if (owner !== claimant.toLowerCase()) return { status: "claimant-mismatch", owner, claimant };
  if (!isUint32(wins) || !isUint32(losses)) return { status: "record-out-of-range", wins, losses };

  return { status: "ok", record: { taruchiId, claimant, recipient, wins, losses } };
}

export function buildAscensionRecordTypedData(args: {
  chainId: number;
  worldAddress: Address;
  taruchiId: bigint;
  claimant: Address;
  recipient: Address;
  wins: number;
  losses: number;
  deadline: bigint;
}): {
  domain: {
    name: "AsphodelPrologue";
    version: "1";
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof ASCENSION_RECORD_TYPES;
  primaryType: "AscensionRecord";
  message: {
    taruchiID: bigint;
    claimant: Address;
    recipient: Address;
    wins: number;
    losses: number;
    deadline: bigint;
  };
} {
  return {
    domain: {
      name: "AsphodelPrologue",
      version: "1",
      chainId: args.chainId,
      verifyingContract: args.worldAddress,
    },
    types: ASCENSION_RECORD_TYPES,
    primaryType: "AscensionRecord" as const,
    message: {
      taruchiID: args.taruchiId,
      claimant: args.claimant,
      recipient: args.recipient,
      wins: args.wins,
      losses: args.losses,
      deadline: args.deadline,
    },
  };
}

export async function signAscensionRecord(args: {
  signer: PrivateKeyAccount;
  chainId: number;
  worldAddress: Address;
  record: AscensionRecord;
  deadline: bigint;
}): Promise<Hex> {
  return args.signer.signTypedData(
    buildAscensionRecordTypedData({
      chainId: args.chainId,
      worldAddress: args.worldAddress,
      taruchiId: args.record.taruchiId,
      claimant: args.record.claimant,
      recipient: args.record.recipient,
      wins: args.record.wins,
      losses: args.record.losses,
      deadline: args.deadline,
    }),
  );
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
