import { Sql } from "postgres";
import { Observable, shareReplay } from "rxjs";
import { StorageAdapterBlock, StorageAdapterLog } from "@latticexyz/store-sync";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import { decodeDynamicField } from "@latticexyz/protocol-parser/internal";
import { Hex } from "viem";
import { recordToLog } from "./recordToLog";
import { debug as parentDebug } from "../debug";

const debug = parentDebug.extend("block-logs-stream");
const schemaName = transformSchemaName("mud");

type CreateBlockLogsStreamOptions = {
  sql: Sql;
  pollingIntervalMs?: number;
};

type BlockRecordRow = {
  address: string;
  tableId: string;
  keyBytes: string;
  staticData: string | null;
  encodedLengths: string | null;
  dynamicData: string | null;
  blockNumber: string;
  logIndex: number;
  isDeleted: boolean | null;
};

function recordToDeleteLog(row: BlockRecordRow): StorageAdapterLog {
  return {
    address: row.address as Hex,
    eventName: "Store_DeleteRecord",
    args: {
      tableId: row.tableId as Hex,
      keyTuple: decodeDynamicField("bytes32[]", row.keyBytes as Hex),
    },
  } as StorageAdapterLog;
}

function rowToLog(row: BlockRecordRow): StorageAdapterLog {
  if (row.isDeleted) return recordToDeleteLog(row);
  return recordToLog({
    address: row.address as Hex,
    tableId: row.tableId as Hex,
    keyBytes: row.keyBytes as Hex,
    staticData: (row.staticData as Hex) ?? null,
    encodedLengths: (row.encodedLengths as Hex) ?? null,
    dynamicData: (row.dynamicData as Hex) ?? null,
    logIndex: row.logIndex,
  });
}

export function createBlockLogsStream({
  sql,
  pollingIntervalMs = 1000,
}: CreateBlockLogsStreamOptions): Observable<StorageAdapterBlock> {
  return new Observable<StorageAdapterBlock>((subscriber) => {
    let lastBlockNumber = -1n;
    let polling = false;

    async function poll(): Promise<void> {
      if (polling) return;
      polling = true;
      try {
        const configRows = await sql`
          SELECT block_number FROM ${sql(`${schemaName}.config`)} LIMIT 1
        `;
        if (configRows.length === 0) return;

        const latestBlockNumber = BigInt(configRows[0].block_number);
        if (latestBlockNumber === lastBlockNumber) return;

        const firstPoll = lastBlockNumber === -1n;
        const records = await sql<BlockRecordRow[]>`
          SELECT
            '0x' || encode(address, 'hex') AS "address",
            '0x' || encode(table_id, 'hex') AS "tableId",
            '0x' || encode(key_bytes, 'hex') AS "keyBytes",
            '0x' || encode(static_data, 'hex') AS "staticData",
            '0x' || encode(encoded_lengths, 'hex') AS "encodedLengths",
            '0x' || encode(dynamic_data, 'hex') AS "dynamicData",
            block_number AS "blockNumber",
            log_index AS "logIndex",
            is_deleted AS "isDeleted"
          FROM ${sql(`${schemaName}.records`)}
          WHERE ${
            firstPoll
              ? sql`block_number = ${latestBlockNumber.toString()}`
              : sql`block_number > ${lastBlockNumber.toString()} AND block_number <= ${latestBlockNumber.toString()}`
          }
          ORDER BY block_number, log_index ASC
        `;

        const blockMap = new Map<bigint, BlockRecordRow[]>();
        for (const row of records) {
          const bn = BigInt(row.blockNumber);
          const existing = blockMap.get(bn);
          if (existing) existing.push(row);
          else blockMap.set(bn, [row]);
        }

        if (blockMap.size === 0) {
          subscriber.next({ blockNumber: latestBlockNumber, logs: [] });
        } else {
          for (const [blockNum, rows] of blockMap) {
            subscriber.next({ blockNumber: blockNum, logs: rows.map(rowToLog) });
          }
        }

        lastBlockNumber = latestBlockNumber;
      } catch (err) {
        debug("poll error:", err instanceof Error ? err.message : String(err));
      } finally {
        polling = false;
      }
    }

    poll();
    const intervalId = setInterval(poll, pollingIntervalMs);
    return () => clearInterval(intervalId);
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}
