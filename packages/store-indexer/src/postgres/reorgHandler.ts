import { PgDatabase, QueryResultHKT, pgSchema, varchar } from "drizzle-orm/pg-core";
import { gt, sql } from "drizzle-orm";
import { Client, getAddress } from "viem";
import { getBlock } from "viem/actions";
import { getStoredBlockHash } from "./blockCache";
import { restoreFromRewindLog } from "./rewindLog";
import { blockCacheTable, rewindLogTable } from "./reorgTables";
import { tables as mudTables, transformSchemaName } from "@latticexyz/store-sync/postgres";
import { isNotNull } from "@latticexyz/common/utils";
import { logger } from "../logger";
import { REFERRAL_REWARDS_TABLE_ID, referrerFromKeyBytes, uint256FromHex } from "./referralRewardsProjection";

const log = logger.child({ component: "reorg" });
const mudSchemaName = transformSchemaName("mud");

const schemata = pgSchema("information_schema").table("schemata", {
  schemaName: varchar("schema_name", { length: 64 }),
});

type RawReferralRewardRow = {
  key_bytes?: string;
  static_data?: string | null;
  block_number?: string;
  log_index?: number;
};

export async function findCommonAncestor(
  db: PgDatabase<QueryResultHKT>,
  publicClient: Client,
  fromBlock: bigint,
  maxDepth: bigint = 64n,
): Promise<bigint> {
  let blockNumber = fromBlock;
  const minBlock = fromBlock - maxDepth;

  while (blockNumber > 0n && blockNumber >= minBlock) {
    const storedHash = await getStoredBlockHash(db, blockNumber);
    if (!storedHash) return blockNumber;

    const canonicalBlock = await getBlock(publicClient, { blockNumber });
    if (canonicalBlock.hash === storedHash) return blockNumber;

    log.info("block hash mismatch", { blockNumber, storedHash, canonicalHash: canonicalBlock.hash });
    blockNumber--;
  }

  throw new Error(`Reorg deeper than ${maxDepth} blocks from block ${fromBlock}. Manual intervention required.`);
}

export async function rollbackToBlock(
  db: PgDatabase<QueryResultHKT>,
  targetBlock: bigint,
  opts?: { decoded?: boolean },
): Promise<void> {
  log.info("rolling back", { targetBlock });

  const entries = await restoreFromRewindLog(db, targetBlock);
  log.info("restored raw record snapshots", { count: entries.length, targetBlock });

  let decodedSchemaNames: string[] = [];
  if (opts?.decoded !== false) {
    decodedSchemaNames = await deleteStaleDecodedRows(db, targetBlock);
    await rollbackReferralRewardProjection(db, targetBlock, decodedSchemaNames);
  }

  await db.delete(rewindLogTable).where(gt(rewindLogTable.blockNumber, targetBlock)).execute();
  await db.delete(blockCacheTable).where(gt(blockCacheTable.blockNumber, targetBlock)).execute();
  await db.update(mudTables.configTable).set({ blockNumber: targetBlock }).execute();

  log.info("rollback complete", { targetBlock });
}

async function deleteStaleDecodedRows(db: PgDatabase<QueryResultHKT>, targetBlock: bigint): Promise<string[]> {
  const schemaNames = (await db.select({ schemaName: schemata.schemaName }).from(schemata).execute())
    .map((row) => row.schemaName)
    .filter(isNotNull)
    .filter((name) => /(^|__)0x[0-9a-f]{40}($|__)/i.test(name));

  if (schemaNames.length === 0) return [];

  for (const schemaName of schemaNames) {
    const tablesResult = await db.execute(
      sql.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaName}'`),
    );

    const rows = ((tablesResult as Record<string, unknown>).rows ?? tablesResult) as { table_name?: string }[];
    for (const row of rows) {
      const tableName = row.table_name;
      if (!tableName) continue;

      await db.execute(
        sql.raw(`DELETE FROM "${schemaName}"."${tableName}" WHERE __last_updated_block_number > ${targetBlock}`),
      );
      log.info("cleaned decoded table", { schema: schemaName, table: tableName });
    }
  }

  return schemaNames;
}

async function rollbackReferralRewardProjection(
  db: PgDatabase<QueryResultHKT>,
  targetBlock: bigint,
  schemaNames: readonly string[],
): Promise<void> {
  try {
    const storeAddresses = schemaNames.map(addressFromSchemaName).filter(isNotNull);

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM ${sql.raw(`"${mudSchemaName}"."referral_reward_events"`)}
        WHERE block_number > ${targetBlock.toString()}
      `);
      await tx.execute(sql`DELETE FROM ${sql.raw(`"${mudSchemaName}"."referral_reward_state"`)}`);

      if (storeAddresses.length === 0) return;

      const addressFilter = storeAddresses.map((address) => `decode('${address.slice(2)}', 'hex')`).join(", ");
      const recordsResult = await tx.execute(
        sql.raw(`
          SELECT
            '0x' || encode(key_bytes, 'hex') AS key_bytes,
            '0x' || encode(static_data, 'hex') AS static_data,
            block_number::text AS block_number,
            log_index::int AS log_index
          FROM "${mudSchemaName}"."records"
          WHERE address IN (${addressFilter})
            AND table_id = decode('${REFERRAL_REWARDS_TABLE_ID.slice(2)}', 'hex')
            AND is_deleted IS DISTINCT FROM true
            AND static_data IS NOT NULL
        `),
      );
      const rows = ((recordsResult as Record<string, unknown>).rows ?? recordsResult) as RawReferralRewardRow[];

      for (const row of rows) {
        const referrer = referrerFromKeyBytes(row.key_bytes);
        const claimable = uint256FromHex(row.static_data);
        if (!referrer || claimable === null || claimable === 0n) continue;

        await tx.execute(sql`
          INSERT INTO ${sql.raw(`"${mudSchemaName}"."referral_reward_state"`)}
            (referrer, claimable_onyx_wei, updated_block_number, updated_log_index)
          VALUES (
            ${referrer},
            ${claimable.toString()},
            ${BigInt(row.block_number ?? "0").toString()},
            ${Number(row.log_index ?? 0)}
          )
          ON CONFLICT (referrer) DO UPDATE SET
            claimable_onyx_wei = EXCLUDED.claimable_onyx_wei,
            updated_block_number = EXCLUDED.updated_block_number,
            updated_log_index = EXCLUDED.updated_log_index
        `);
      }
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "3F000") return;
    throw error;
  }
}

function addressFromSchemaName(schemaName: string): string | null {
  const match = schemaName.match(/0x[0-9a-f]{40}/i);
  if (!match) return null;
  try {
    return getAddress(match[0]).toLowerCase();
  } catch {
    return null;
  }
}
