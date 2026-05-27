import { Hex, encodePacked, parseAbi, size } from "viem";
import { PgDatabase, QueryResultHKT } from "drizzle-orm/pg-core";
import { and, eq, sql } from "drizzle-orm";
import { debug } from "./debug";
import { tables } from "./tables";
import { hexToResource, spliceHex } from "@latticexyz/common";
import { setupTables } from "./setupTables";
import { StorageAdapter, StorageAdapterBlock } from "../common";
import { version } from "./version";
import { getAction } from "viem/utils";
import { getBlockNumber, getChainId, readContract } from "viem/actions";
import { GetRpcClientOptions, getRpcClient } from "@latticexyz/block-logs-stream";

const getRecordAbi = parseAbi([
  "function getRecord(bytes32 tableId, bytes32[] keyTuple) view returns (bytes staticData, bytes32 encodedLengths, bytes dynamicData)",
]);

type OnchainState = {
  staticData: Hex;
  encodedLengths: Hex;
  dynamicData: Hex;
  isDeleted: boolean;
};

// Currently assumes one DB per chain ID

export type PostgresStorageAdapter = {
  storageAdapter: StorageAdapter;
  tables: typeof tables;
  cleanUp: () => Promise<void>;
};

export async function createStorageAdapter({
  database,
  backfillMode = false,
  ...opts
}: GetRpcClientOptions & {
  database: PgDatabase<QueryResultHKT>;
  backfillMode?: boolean;
}): Promise<PostgresStorageAdapter> {
  const cleanUp: (() => Promise<void>)[] = [];

  const publicClient = getRpcClient(opts);
  const chainId = publicClient.chain?.id ?? (await getAction(publicClient, getChainId, "getChainId")({}));

  cleanUp.push(await setupTables(database, Object.values(tables)));

  // Backfill-only state: lazily-fetched chain head and per-key cache for onchain `getRecord` lookups.
  // The head is fixed for the whole run so repeat reads of the same key are consistent.
  let backfillHead: bigint | null = null;
  const onchainCache = new Map<string, OnchainState>();

  async function getOnchainState(address: Hex, tableId: Hex, keyTuple: readonly Hex[]): Promise<OnchainState> {
    const cacheKey = `${address.toLowerCase()}:${tableId.toLowerCase()}:${encodePacked(["bytes32[]"], [keyTuple]).toLowerCase()}`;
    const cached = onchainCache.get(cacheKey);
    if (cached) return cached;
    if (backfillHead == null) {
      backfillHead = await getAction(publicClient, getBlockNumber, "getBlockNumber")({});
    }
    const [staticData, encodedLengths, dynamicData] = (await readContract(publicClient, {
      address,
      abi: getRecordAbi,
      functionName: "getRecord",
      args: [tableId, keyTuple as Hex[]],
      blockNumber: backfillHead,
    })) as [Hex, Hex, Hex];
    const state: OnchainState = {
      staticData,
      encodedLengths,
      dynamicData,
      isDeleted: staticData === "0x" && dynamicData === "0x",
    };
    onchainCache.set(cacheKey, state);
    return state;
  }

  async function postgresStorageAdapter({ blockNumber, logs }: StorageAdapterBlock): Promise<void> {
    await database.transaction(async (tx) => {
      for (const log of logs) {
        const keyBytes = encodePacked(["bytes32[]"], [log.args.keyTuple]);

        // In backfill mode, rewrite onchain rows from canonical contract state instead of replaying events.
        // Sidesteps the "missed splice, newer splice on top" gotcha: getRecord at head is the truth.
        // Offchain tables fall through to the normal guarded event handlers below.
        if (backfillMode && hexToResource(log.args.tableId).type !== "offchainTable") {
          const state = await getOnchainState(log.address, log.args.tableId, log.args.keyTuple);
          const head = backfillHead!;
          await tx
            .insert(tables.recordsTable)
            .values({
              address: log.address,
              tableId: log.args.tableId,
              keyBytes,
              key0: log.args.keyTuple[0],
              key1: log.args.keyTuple[1],
              staticData: state.staticData,
              encodedLengths: state.encodedLengths,
              dynamicData: state.dynamicData,
              blockNumber: head,
              logIndex: 0,
              isDeleted: state.isDeleted,
            })
            .onConflictDoUpdate({
              target: [tables.recordsTable.address, tables.recordsTable.tableId, tables.recordsTable.keyBytes],
              set: {
                staticData: state.staticData,
                encodedLengths: state.encodedLengths,
                dynamicData: state.dynamicData,
                blockNumber: head,
                logIndex: 0,
                isDeleted: state.isDeleted,
              },
            })
            .execute();
          continue;
        }

        if (log.eventName === "Store_SetRecord") {
          debug("upserting record", {
            address: log.address,
            tableId: log.args.tableId,
            keyTuple: log.args.keyTuple,
          });

          await tx
            .insert(tables.recordsTable)
            .values({
              address: log.address,
              tableId: log.args.tableId,
              keyBytes,
              key0: log.args.keyTuple[0],
              key1: log.args.keyTuple[1],
              staticData: log.args.staticData,
              encodedLengths: log.args.encodedLengths,
              dynamicData: log.args.dynamicData,
              blockNumber,
              logIndex: log.logIndex ?? 0,
              isDeleted: false,
            })
            .onConflictDoUpdate({
              target: [tables.recordsTable.address, tables.recordsTable.tableId, tables.recordsTable.keyBytes],
              set: {
                staticData: log.args.staticData,
                encodedLengths: log.args.encodedLengths,
                dynamicData: log.args.dynamicData,
                blockNumber,
                logIndex: log.logIndex ?? 0,
                isDeleted: false,
              },
              where: backfillMode ? sql`${tables.recordsTable.blockNumber} < ${blockNumber}` : undefined,
            })
            .execute();
        } else if (log.eventName === "Store_SpliceStaticData") {
          // TODO: replace this operation with SQL `overlay()` (https://www.postgresql.org/docs/9.3/functions-binarystring.html)

          const previousValue = await tx
            .select({ staticData: tables.recordsTable.staticData })
            .from(tables.recordsTable)
            .where(
              and(
                eq(tables.recordsTable.address, log.address),
                eq(tables.recordsTable.tableId, log.args.tableId),
                eq(tables.recordsTable.keyBytes, keyBytes),
              ),
            )
            .limit(1)
            .execute()
            // Get the first record in a way that returns a possible `undefined`
            // TODO: move this to `.findFirst` after upgrading drizzle or `rows[0]` after enabling `noUncheckedIndexedAccess: true`
            .then((rows) => rows.find(() => true));

          const previousStaticData = previousValue?.staticData ?? "0x";
          const newStaticData = spliceHex(previousStaticData, log.args.start, size(log.args.data), log.args.data);

          debug("upserting record via splice static", {
            address: log.address,
            tableId: log.args.tableId,
            keyTuple: log.args.keyTuple,
          });

          await tx
            .insert(tables.recordsTable)
            .values({
              address: log.address,
              tableId: log.args.tableId,
              keyBytes,
              key0: log.args.keyTuple[0],
              key1: log.args.keyTuple[1],
              staticData: newStaticData,
              blockNumber,
              logIndex: log.logIndex ?? 0,
              isDeleted: false,
            })
            .onConflictDoUpdate({
              target: [tables.recordsTable.address, tables.recordsTable.tableId, tables.recordsTable.keyBytes],
              set: {
                staticData: newStaticData,
                blockNumber,
                logIndex: log.logIndex,
                isDeleted: false,
              },
              where: backfillMode ? sql`${tables.recordsTable.blockNumber} < ${blockNumber}` : undefined,
            })
            .execute();
        } else if (log.eventName === "Store_SpliceDynamicData") {
          // TODO: replace this operation with SQL `overlay()` (https://www.postgresql.org/docs/9.3/functions-binarystring.html)

          const previousValue = await tx
            .select({ dynamicData: tables.recordsTable.dynamicData })
            .from(tables.recordsTable)
            .where(
              and(
                eq(tables.recordsTable.address, log.address),
                eq(tables.recordsTable.tableId, log.args.tableId),
                eq(tables.recordsTable.keyBytes, keyBytes),
              ),
            )
            .limit(1)
            .execute()
            // Get the first record in a way that returns a possible `undefined`
            // TODO: move this to `.findFirst` after upgrading drizzle or `rows[0]` after enabling `noUncheckedIndexedAccess: true`
            .then((rows) => rows.find(() => true));

          const previousDynamicData = previousValue?.dynamicData ?? "0x";
          const newDynamicData = spliceHex(previousDynamicData, log.args.start, log.args.deleteCount, log.args.data);

          debug("upserting record via splice dynamic", {
            address: log.address,
            tableId: log.args.tableId,
            keyTuple: log.args.keyTuple,
          });

          await tx
            .insert(tables.recordsTable)
            .values({
              address: log.address,
              tableId: log.args.tableId,
              keyBytes,
              key0: log.args.keyTuple[0],
              key1: log.args.keyTuple[1],
              encodedLengths: log.args.encodedLengths,
              dynamicData: newDynamicData,
              blockNumber,
              logIndex: log.logIndex ?? 0,
              isDeleted: false,
            })
            .onConflictDoUpdate({
              target: [tables.recordsTable.address, tables.recordsTable.tableId, tables.recordsTable.keyBytes],
              set: {
                encodedLengths: log.args.encodedLengths,
                dynamicData: newDynamicData,
                blockNumber: blockNumber,
                logIndex: log.logIndex ?? 0,
                isDeleted: false,
              },
              where: backfillMode ? sql`${tables.recordsTable.blockNumber} < ${blockNumber}` : undefined,
            })
            .execute();
        } else if (log.eventName === "Store_DeleteRecord") {
          debug("deleting record", {
            address: log.address,
            tableId: log.args.tableId,
            keyTuple: log.args.keyTuple,
          });

          await tx
            .update(tables.recordsTable)
            .set({
              staticData: null,
              encodedLengths: null,
              dynamicData: null,
              blockNumber,
              logIndex: log.logIndex ?? 0,
              isDeleted: true,
            })
            .where(
              and(
                eq(tables.recordsTable.address, log.address),
                eq(tables.recordsTable.tableId, log.args.tableId),
                eq(tables.recordsTable.keyBytes, keyBytes),
                ...(backfillMode ? [sql`${tables.recordsTable.blockNumber} < ${blockNumber}`] : []),
              ),
            )
            .execute();
        }
      }

      if (!backfillMode) {
        await tx
          .insert(tables.configTable)
          .values({
            version,
            chainId,
            blockNumber,
          })
          .onConflictDoUpdate({
            target: [tables.configTable.chainId],
            set: {
              blockNumber,
            },
          })
          .execute();
      }
    });
  }

  return {
    storageAdapter: postgresStorageAdapter,
    tables,
    cleanUp: async (): Promise<void> => {
      for (const fn of cleanUp) {
        await fn();
      }
    },
  };
}
