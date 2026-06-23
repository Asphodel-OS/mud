import { isAddress, zeroAddress } from "viem";

export type AccountRow = {
  owner: string | null;
  index: number | string;
  referrer: string | null;
  createdBlock: number | string | bigint;
};

export interface IndexedAccount {
  index: number;
  referrer: string | null;
  createdBlock: string;
}

export interface AccountAggregate {
  accountByOwner: Map<string, IndexedAccount>;
  referralCountByReferrer: Map<string, number>;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value || !isAddress(value, { strict: false })) return null;
  return value.toLowerCase();
}

export function buildAccountAggregate(rows: AccountRow[]): AccountAggregate {
  const accountByOwner = new Map<string, IndexedAccount>();
  const referralCountByReferrer = new Map<string, number>();
  const zero = zeroAddress.toLowerCase();

  for (const row of rows) {
    const owner = normalizeAddress(row.owner);
    const index = Number(row.index);
    if (!owner || owner === zero || !Number.isFinite(index) || index <= 0) continue;

    const referrer = normalizeAddress(row.referrer);
    const normalizedReferrer = referrer && referrer !== zero && referrer !== owner ? referrer : null;

    accountByOwner.set(owner, {
      index,
      referrer: normalizedReferrer,
      createdBlock: row.createdBlock.toString(),
    });

    if (normalizedReferrer) {
      referralCountByReferrer.set(normalizedReferrer, (referralCountByReferrer.get(normalizedReferrer) ?? 0) + 1);
    }
  }

  return { accountByOwner, referralCountByReferrer };
}
