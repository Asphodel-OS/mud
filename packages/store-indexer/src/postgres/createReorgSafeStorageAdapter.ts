import { PgDatabase, QueryResultHKT } from "drizzle-orm/pg-core";
import { Address, Hex, PublicClient, encodePacked } from "viem";
import { getBlock } from "viem/actions";
import { StorageAdapter, StorageAdapterBlock } from "@latticexyz/store-sync";
import { setupTables } from "@latticexyz/store-sync/postgres";
import { storeBlockHash, getStoredBlockHash, pruneBlockCache } from "./blockCache";
import { snapshotRecords, pruneRewindLog } from "./rewindLog";
import { reorgTables } from "./reorgTables";
import { findCommonAncestor, rollbackToBlock } from "./reorgHandler";
import { ReorgError } from "./ReorgError";

export type ReorgSafeStorageAdapterOptions = {
  storageAdapter: StorageAdapter;
  database: PgDatabase<QueryResultHKT>;
  publicClient: PublicClient;
  reorgWindow?: bigint;
  decoded?: boolean;
};

export async function createReorgSafeStorageAdapter({
  storageAdapter,
  database,
  publicClient,
  reorgWindow = 64n,
  decoded = true,
}: ReorgSafeStorageAdapterOptions): Promise<StorageAdapter> {
  await setupTables(database, Object.values(reorgTables));

  async function reorgSafeStorageAdapter(block: StorageAdapterBlock): Promise<void> {
    const { blockNumber, logs } = block;

    const blockHash = logs.length > 0 ? (logs[0] as { blockHash?: string }).blockHash : undefined;

    const prevStoredHash = await getStoredBlockHash(database, blockNumber - 1n);
    if (prevStoredHash && blockHash) {
      const blockHeader = await getBlock(publicClient, { blockNumber });
      if (blockHeader.parentHash !== prevStoredHash) {
        console.log(
          `[reorg] detected at block ${blockNumber}: ` +
            `parentHash=${blockHeader.parentHash} != storedHash=${prevStoredHash}`,
        );

        const commonAncestor = await findCommonAncestor(database, publicClient, blockNumber - 1n, reorgWindow);

        await rollbackToBlock(database, commonAncestor, { decoded });
        throw new ReorgError(commonAncestor, blockNumber);
      }
    }

    const recordKeys = extractRecordKeys(logs);
    if (recordKeys.length > 0) {
      await snapshotRecords(database, blockNumber, recordKeys);
    }

    await storageAdapter(block);

    if (blockHash) {
      await storeBlockHash(database, blockNumber, blockHash);
    }

    if (blockNumber % 10n === 0n) {
      const pruneBelow = blockNumber - reorgWindow;
      if (pruneBelow > 0n) {
        await pruneBlockCache(database, pruneBelow);
        await pruneRewindLog(database, pruneBelow);
      }
    }
  }

  return reorgSafeStorageAdapter;
}

function extractRecordKeys(logs: StorageAdapterBlock["logs"]): { address: Address; tableId: Hex; keyBytes: Hex }[] {
  const keys: { address: Address; tableId: Hex; keyBytes: Hex }[] = [];

  for (const log of logs) {
    if (
      log.eventName === "Store_SetRecord" ||
      log.eventName === "Store_SpliceStaticData" ||
      log.eventName === "Store_SpliceDynamicData" ||
      log.eventName === "Store_DeleteRecord"
    ) {
      const args = log.args as { keyTuple?: Hex[]; tableId?: Hex };
      if (args.keyTuple) {
        keys.push({
          address: log.address as Address,
          tableId: args.tableId as Hex,
          keyBytes: encodePacked(["bytes32[]"], [keyTuple]),
        });
      }
    }
  }

  return keys;
}
