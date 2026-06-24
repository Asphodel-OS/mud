import type { Sql } from "postgres";
import type { StorageAdapter, StorageAdapterBlock, StorageAdapterLog } from "@latticexyz/store-sync";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import { getAddress, hexToBytes, isAddress, type Hex } from "viem";
import { logger } from "../logger";

const log = logger.child({ component: "referral-rewards" });
const mudSchemaName = transformSchemaName("mud");

export const REFERRAL_REWARDS_TABLE_ID = "0x74626170700000000000000000000000526566657272616c5265776172647300" as Hex;

export type IndexedReferralRewards = {
  claimableOnyxWei: string;
  lifetimeEarnedOnyxWei: string;
};

export type ReferralRewardProjectionRow = {
  referrer: string;
  claimableOnyxWei: string;
  lifetimeEarnedOnyxWei: string;
};

export type ReferralRewardDelta = {
  blockNumber: bigint;
  logIndex: number;
  referrer: string;
  amountOnyxWei: bigint;
  claimableOnyxWei: bigint;
};

type StateRow = {
  referrer: string;
  claimableOnyxWei: string;
};

type RawReferralRewardRecord = {
  keyBytes: string;
  staticData: string | null;
  blockNumber: string;
  logIndex: number;
};

const UINT256_HEX_LENGTH = 66;

function projectionIdentifier(tableName: string): string {
  return `"${mudSchemaName}"."${tableName}"`;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value || !isAddress(value, { strict: false })) return null;
  return value.toLowerCase();
}

export function referrerFromKeyBytes(keyBytes: string | null | undefined): string | null {
  if (!keyBytes || keyBytes.length !== UINT256_HEX_LENGTH) return null;
  try {
    return getAddress(`0x${keyBytes.slice(-40)}`).toLowerCase();
  } catch {
    return null;
  }
}

function referrerFromKeyTuple(keyTuple: readonly Hex[] | undefined): string | null {
  return referrerFromKeyBytes(keyTuple?.[0]);
}

export function uint256FromHex(data: string | null | undefined): bigint | null {
  if (!data || data.length < UINT256_HEX_LENGTH) return null;
  try {
    return BigInt(data.slice(0, UINT256_HEX_LENGTH));
  } catch {
    return null;
  }
}

function claimableFromLog(log: StorageAdapterLog): bigint | null {
  if (log.eventName === "Store_DeleteRecord") return 0n;
  if (log.eventName === "Store_SetRecord") {
    return uint256FromHex(log.args.staticData as Hex | undefined);
  }
  if (log.eventName === "Store_SpliceStaticData") {
    const start = Number((log.args as { start?: number | bigint }).start ?? 0);
    if (start !== 0) return null;
    return uint256FromHex((log.args as { data?: Hex }).data);
  }
  return null;
}

export function collectReferralRewardDeltas(
  logs: readonly StorageAdapterLog[],
  blockNumber: bigint,
  initialClaimableByReferrer: ReadonlyMap<string, bigint>,
): { deltas: ReferralRewardDelta[]; nextClaimableByReferrer: Map<string, bigint> } {
  const nextClaimableByReferrer = new Map(initialClaimableByReferrer);
  const deltas: ReferralRewardDelta[] = [];

  logs.forEach((entry, ordinal) => {
    if (
      entry.eventName !== "Store_SetRecord" &&
      entry.eventName !== "Store_SpliceStaticData" &&
      entry.eventName !== "Store_DeleteRecord"
    ) {
      return;
    }
    if (entry.args.tableId !== REFERRAL_REWARDS_TABLE_ID) return;

    const referrer = referrerFromKeyTuple(entry.args.keyTuple);
    const nextClaimable = claimableFromLog(entry);
    if (!referrer || nextClaimable === null) return;

    const previousClaimable = nextClaimableByReferrer.get(referrer) ?? 0n;
    if (nextClaimable > previousClaimable) {
      deltas.push({
        blockNumber,
        logIndex: Number(entry.logIndex ?? ordinal),
        referrer,
        amountOnyxWei: nextClaimable - previousClaimable,
        claimableOnyxWei: nextClaimable,
      });
    }
    nextClaimableByReferrer.set(referrer, nextClaimable);
  });

  return { deltas, nextClaimableByReferrer };
}

export function buildReferralRewardsByReferrer(
  rows: ReferralRewardProjectionRow[],
): Map<string, IndexedReferralRewards> {
  const out = new Map<string, IndexedReferralRewards>();
  for (const row of rows) {
    const referrer = normalizeAddress(row.referrer);
    if (!referrer) continue;
    out.set(referrer, {
      claimableOnyxWei: row.claimableOnyxWei,
      lifetimeEarnedOnyxWei: row.lifetimeEarnedOnyxWei,
    });
  }
  return out;
}

export async function ensureReferralRewardProjectionTables(sql: Sql): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${mudSchemaName}"`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${projectionIdentifier("referral_reward_state")} (
      referrer varchar(42) PRIMARY KEY,
      claimable_onyx_wei numeric(78, 0) NOT NULL DEFAULT 0,
      updated_block_number numeric(78, 0) NOT NULL DEFAULT 0,
      updated_log_index integer NOT NULL DEFAULT 0
    )
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${projectionIdentifier("referral_reward_events")} (
      block_number numeric(78, 0) NOT NULL,
      log_index integer NOT NULL,
      referrer varchar(42) NOT NULL,
      amount_onyx_wei numeric(78, 0) NOT NULL,
      claimable_onyx_wei numeric(78, 0) NOT NULL,
      PRIMARY KEY (block_number, log_index, referrer)
    )
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS referral_reward_events_referrer_idx
    ON ${projectionIdentifier("referral_reward_events")} (referrer)
  `);
}

export async function fetchReferralRewardProjectionRows(sql: Sql): Promise<ReferralRewardProjectionRow[]> {
  try {
    return await sql<ReferralRewardProjectionRow[]>`
      WITH lifetime AS (
        SELECT referrer, SUM(amount_onyx_wei) AS lifetime_earned_onyx_wei
        FROM ${sql(`${mudSchemaName}.referral_reward_events`)}
        GROUP BY referrer
      )
      SELECT
        COALESCE(s.referrer, l.referrer) AS referrer,
        COALESCE(s.claimable_onyx_wei, 0)::text AS "claimableOnyxWei",
        COALESCE(l.lifetime_earned_onyx_wei, 0)::text AS "lifetimeEarnedOnyxWei"
      FROM ${sql(`${mudSchemaName}.referral_reward_state`)} s
      FULL OUTER JOIN lifetime l ON l.referrer = s.referrer
    `;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "3F000") return [];
    throw error;
  }
}

async function fetchRawReferralRewardRows(sql: Sql, storeAddress: Hex): Promise<RawReferralRewardRecord[]> {
  try {
    return await sql<RawReferralRewardRecord[]>`
      SELECT
        '0x' || encode(key_bytes, 'hex') AS "keyBytes",
        '0x' || encode(static_data, 'hex') AS "staticData",
        block_number::text AS "blockNumber",
        log_index::int AS "logIndex"
      FROM ${sql(`${mudSchemaName}.records`)}
      WHERE address = ${hexToBytes(storeAddress)}
        AND table_id = ${hexToBytes(REFERRAL_REWARDS_TABLE_ID)}
        AND is_deleted IS DISTINCT FROM true
        AND static_data IS NOT NULL
    `;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "3F000") return [];
    throw error;
  }
}

export async function resetReferralRewardStateFromStoreRecords(
  sql: Sql,
  storeAddresses: readonly string[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM ${tx(`${mudSchemaName}.referral_reward_state`)}`;

    for (const storeAddress of storeAddresses) {
      const normalizedStoreAddress = normalizeAddress(storeAddress) as Hex | null;
      if (!normalizedStoreAddress) continue;

      const rows = await fetchRawReferralRewardRows(tx, normalizedStoreAddress);
      for (const row of rows) {
        const referrer = referrerFromKeyBytes(row.keyBytes);
        const claimable = uint256FromHex(row.staticData);
        if (!referrer || claimable === null || claimable === 0n) continue;

        await tx`
          INSERT INTO ${tx(`${mudSchemaName}.referral_reward_state`)}
            (referrer, claimable_onyx_wei, updated_block_number, updated_log_index)
          VALUES (${referrer}, ${claimable.toString()}, ${row.blockNumber}, ${row.logIndex})
          ON CONFLICT (referrer) DO UPDATE SET
            claimable_onyx_wei = EXCLUDED.claimable_onyx_wei,
            updated_block_number = EXCLUDED.updated_block_number,
            updated_log_index = EXCLUDED.updated_log_index
        `;
      }
    }
  });
}

async function readProjectionState(sql: Sql): Promise<Map<string, bigint>> {
  const rows = await sql<StateRow[]>`
    SELECT referrer, claimable_onyx_wei::text AS "claimableOnyxWei"
    FROM ${sql(`${mudSchemaName}.referral_reward_state`)}
  `;
  return new Map(rows.map((row) => [row.referrer, BigInt(row.claimableOnyxWei)]));
}

async function applyReferralRewardProjection(sql: Sql, block: StorageAdapterBlock): Promise<void> {
  const touched = new Set<string>();
  const lastTouchedLogIndexByReferrer = new Map<string, number>();
  block.logs.forEach((entry, ordinal) => {
    if (
      entry.args.tableId === REFERRAL_REWARDS_TABLE_ID &&
      (entry.eventName === "Store_SetRecord" ||
        entry.eventName === "Store_SpliceStaticData" ||
        entry.eventName === "Store_DeleteRecord")
    ) {
      const referrer = referrerFromKeyTuple(entry.args.keyTuple);
      if (referrer) {
        touched.add(referrer);
        lastTouchedLogIndexByReferrer.set(referrer, Number(entry.logIndex ?? ordinal));
      }
    }
  });
  if (touched.size === 0) return;

  const initialState = await readProjectionState(sql);
  const { deltas, nextClaimableByReferrer } = collectReferralRewardDeltas(block.logs, block.blockNumber, initialState);

  await sql.begin(async (tx) => {
    for (const delta of deltas) {
      await tx`
        INSERT INTO ${tx(`${mudSchemaName}.referral_reward_events`)}
          (block_number, log_index, referrer, amount_onyx_wei, claimable_onyx_wei)
        VALUES (
          ${delta.blockNumber.toString()},
          ${delta.logIndex},
          ${delta.referrer},
          ${delta.amountOnyxWei.toString()},
          ${delta.claimableOnyxWei.toString()}
        )
        ON CONFLICT (block_number, log_index, referrer) DO NOTHING
      `;
    }

    for (const referrer of touched) {
      await tx`
        INSERT INTO ${tx(`${mudSchemaName}.referral_reward_state`)}
          (referrer, claimable_onyx_wei, updated_block_number, updated_log_index)
        VALUES (
          ${referrer},
          ${(nextClaimableByReferrer.get(referrer) ?? 0n).toString()},
          ${block.blockNumber.toString()},
          ${lastTouchedLogIndexByReferrer.get(referrer) ?? 0}
        )
        ON CONFLICT (referrer) DO UPDATE SET
          claimable_onyx_wei = EXCLUDED.claimable_onyx_wei,
          updated_block_number = EXCLUDED.updated_block_number,
          updated_log_index = EXCLUDED.updated_log_index
      `;
    }
  });
}

export function createReferralRewardProjectionAdapter(sql: Sql): { wrap(inner: StorageAdapter): StorageAdapter } {
  return {
    wrap:
      (inner): StorageAdapter =>
      async (block): Promise<void> => {
        await inner(block);
        try {
          await applyReferralRewardProjection(sql, block);
        } catch (error) {
          log.error("projection failed", {
            blockNumber: block.blockNumber.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
  };
}
