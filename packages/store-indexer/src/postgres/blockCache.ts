import { PgDatabase, QueryResultHKT } from "drizzle-orm/pg-core";
import { eq, lt } from "drizzle-orm";
import { blockCacheTable } from "./reorgTables";

export async function storeBlockHash(
  db: PgDatabase<QueryResultHKT>,
  blockNumber: bigint,
  blockHash: string,
): Promise<void> {
  await db
    .insert(blockCacheTable)
    .values({ blockNumber, blockHash })
    .onConflictDoUpdate({
      target: [blockCacheTable.blockNumber],
      set: { blockHash },
    })
    .execute();
}

export async function getStoredBlockHash(
  db: PgDatabase<QueryResultHKT>,
  blockNumber: bigint,
): Promise<string | undefined> {
  const row = await db
    .select({ blockHash: blockCacheTable.blockHash })
    .from(blockCacheTable)
    .where(eq(blockCacheTable.blockNumber, blockNumber))
    .limit(1)
    .execute()
    .then((rows) => rows.find(() => true));
  return row?.blockHash;
}

export async function pruneBlockCache(db: PgDatabase<QueryResultHKT>, beforeBlock: bigint): Promise<void> {
  await db.delete(blockCacheTable).where(lt(blockCacheTable.blockNumber, beforeBlock)).execute();
}
