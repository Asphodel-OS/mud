import { PgDatabase, QueryResultHKT, pgSchema, varchar } from "drizzle-orm/pg-core";
import { gt, sql } from "drizzle-orm";
import { PublicClient } from "viem";
import { getBlock } from "viem/actions";
import { getStoredBlockHash } from "./blockCache";
import { restoreFromRewindLog } from "./rewindLog";
import { blockCacheTable, rewindLogTable } from "./reorgTables";
import { tables as mudTables } from "@latticexyz/store-sync/postgres";
import { isNotNull } from "@latticexyz/common/utils";

const schemata = pgSchema("information_schema").table("schemata", {
  schemaName: varchar("schema_name", { length: 64 }),
});

export async function findCommonAncestor(
  db: PgDatabase<QueryResultHKT>,
  publicClient: PublicClient,
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

    console.log(`[reorg] block ${blockNumber} hash mismatch: stored=${storedHash} canonical=${canonicalBlock.hash}`);
    blockNumber--;
  }

  throw new Error(`Reorg deeper than ${maxDepth} blocks from block ${fromBlock}. Manual intervention required.`);
}

export async function rollbackToBlock(
  db: PgDatabase<QueryResultHKT>,
  targetBlock: bigint,
  opts?: { decoded?: boolean },
): Promise<void> {
  console.log(`[reorg] rolling back to block ${targetBlock}`);

  const entries = await restoreFromRewindLog(db, targetBlock);
  console.log(`[reorg] restored ${entries.length} raw record snapshots`);

  if (opts?.decoded !== false) {
    await deleteStaleDecodedRows(db, targetBlock);
  }

  await db.delete(rewindLogTable).where(gt(rewindLogTable.blockNumber, targetBlock)).execute();
  await db.delete(blockCacheTable).where(gt(blockCacheTable.blockNumber, targetBlock)).execute();
  await db.update(mudTables.configTable).set({ blockNumber: targetBlock }).execute();

  console.log(`[reorg] rollback complete, config reset to block ${targetBlock}`);
}

async function deleteStaleDecodedRows(db: PgDatabase<QueryResultHKT>, targetBlock: bigint): Promise<void> {
  const schemaNames = (await db.select({ schemaName: schemata.schemaName }).from(schemata).execute())
    .map((row) => row.schemaName)
    .filter(isNotNull)
    .filter((name) => /(^|__)0x[0-9a-f]{40}($|__)/i.test(name));

  if (schemaNames.length === 0) return;

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
      console.log(`[reorg] cleaned decoded table ${schemaName}.${tableName}`);
    }
  }
}
