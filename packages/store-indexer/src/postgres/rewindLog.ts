import { PgDatabase, QueryResultHKT } from "drizzle-orm/pg-core";
import { and, eq, gt, lt, desc } from "drizzle-orm";
import { Address, Hex } from "viem";
import { rewindLogTable } from "./reorgTables";
import { tables as mudTables } from "@latticexyz/store-sync/postgres";

export async function snapshotRecords(
  db: PgDatabase<QueryResultHKT>,
  blockNumber: bigint,
  keys: { address: Address; tableId: Hex; keyBytes: Hex }[],
): Promise<void> {
  if (keys.length === 0) return;

  const seen = new Set<string>();
  const uniqueKeys = keys.filter((k) => {
    const id = `${k.address}:${k.tableId}:${k.keyBytes}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  for (const key of uniqueKeys) {
    const existing = await db
      .select({
        staticData: mudTables.recordsTable.staticData,
        encodedLengths: mudTables.recordsTable.encodedLengths,
        dynamicData: mudTables.recordsTable.dynamicData,
        isDeleted: mudTables.recordsTable.isDeleted,
        blockNumber: mudTables.recordsTable.blockNumber,
      })
      .from(mudTables.recordsTable)
      .where(
        and(
          eq(mudTables.recordsTable.address, key.address),
          eq(mudTables.recordsTable.tableId, key.tableId),
          eq(mudTables.recordsTable.keyBytes, key.keyBytes),
        ),
      )
      .limit(1)
      .execute()
      .then((rows) => rows.find(() => true));

    await db
      .insert(rewindLogTable)
      .values({
        blockNumber,
        address: key.address,
        tableId: key.tableId,
        keyBytes: key.keyBytes,
        prevStaticData: existing?.staticData ?? null,
        prevEncodedLengths: existing?.encodedLengths ?? null,
        prevDynamicData: existing?.dynamicData ?? null,
        prevIsDeleted: existing?.isDeleted ?? null,
        prevRecordExists: !!existing,
        prevBlockNumber: existing?.blockNumber ?? null,
      })
      .execute();
  }
}

export type RewindEntry = {
  blockNumber: bigint;
  address: Address;
  tableId: Hex;
  keyBytes: Hex;
  prevStaticData: Hex | null;
  prevEncodedLengths: Hex | null;
  prevDynamicData: Hex | null;
  prevIsDeleted: boolean | null;
  prevBlockNumber: bigint | null;
  prevRecordExists: boolean;
};

export async function getRewindEntries(db: PgDatabase<QueryResultHKT>, afterBlock: bigint): Promise<RewindEntry[]> {
  return db
    .select()
    .from(rewindLogTable)
    .where(gt(rewindLogTable.blockNumber, afterBlock))
    .orderBy(desc(rewindLogTable.blockNumber))
    .execute() as Promise<RewindEntry[]>;
}

export async function restoreFromRewindLog(db: PgDatabase<QueryResultHKT>, afterBlock: bigint): Promise<RewindEntry[]> {
  const entries = await getRewindEntries(db, afterBlock);

  const restored = new Set<string>();

  await db.transaction(async (tx) => {
    for (const entry of entries) {
      const id = `${entry.address}:${entry.tableId}:${entry.keyBytes}`;
      if (restored.has(id)) continue;
      restored.add(id);

      if (entry.prevRecordExists) {
        await tx
          .update(mudTables.recordsTable)
          .set({
            staticData: entry.prevStaticData,
            encodedLengths: entry.prevEncodedLengths,
            dynamicData: entry.prevDynamicData,
            isDeleted: entry.prevIsDeleted,
            blockNumber: entry.prevBlockNumber ?? afterBlock,
          })
          .where(
            and(
              eq(mudTables.recordsTable.address, entry.address),
              eq(mudTables.recordsTable.tableId, entry.tableId),
              eq(mudTables.recordsTable.keyBytes, entry.keyBytes),
            ),
          )
          .execute();
      } else {
        await tx
          .delete(mudTables.recordsTable)
          .where(
            and(
              eq(mudTables.recordsTable.address, entry.address),
              eq(mudTables.recordsTable.tableId, entry.tableId),
              eq(mudTables.recordsTable.keyBytes, entry.keyBytes),
            ),
          )
          .execute();
      }
    }
  });

  return entries;
}

export async function pruneRewindLog(db: PgDatabase<QueryResultHKT>, beforeBlock: bigint): Promise<void> {
  await db.delete(rewindLogTable).where(lt(rewindLogTable.blockNumber, beforeBlock)).execute();
}
