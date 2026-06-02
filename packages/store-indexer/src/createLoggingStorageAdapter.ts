import { StorageAdapter, StorageAdapterBlock } from "@latticexyz/store-sync";
import { hexToResource } from "@latticexyz/common";
import { Logger } from "./logger";

function tableLabel(tableId: `0x${string}`): string {
  const { namespace, name } = hexToResource(tableId);
  return namespace ? `${namespace}__${name}` : name;
}

export function createLoggingStorageAdapter(inner: StorageAdapter, logger: Logger): StorageAdapter {
  const log = logger.child({ component: "sync" });
  let blocksProcessed = 0;
  let eventsSinceLastSummary = 0;
  const tableCountsSinceLastSummary: Record<string, number> = {};

  return async (block: StorageAdapterBlock): Promise<void> => {
    const { blockNumber, logs } = block;

    if (logs.length > 0) {
      const tableCounts: Record<string, number> = {};
      for (const entry of logs) {
        const table = tableLabel(entry.args.tableId);
        tableCounts[table] = (tableCounts[table] ?? 0) + 1;
        tableCountsSinceLastSummary[table] = (tableCountsSinceLastSummary[table] ?? 0) + 1;
      }

      log.info("block processed", { blockNumber, events: logs.length, tables: tableCounts });
    }

    eventsSinceLastSummary += logs.length;
    blocksProcessed++;

    if (blocksProcessed % 1000 === 0) {
      log.info("sync progress", {
        blockNumber,
        blocksProcessed,
        eventsSinceLast: eventsSinceLastSummary,
        tables: { ...tableCountsSinceLastSummary },
      });
      eventsSinceLastSummary = 0;
      for (const key in tableCountsSinceLastSummary) delete tableCountsSinceLastSummary[key];
    }

    return inner(block);
  };
}
