import { StorageAdapter, StorageAdapterBlock } from "@latticexyz/store-sync";
import { Logger } from "./logger";

export function createLoggingStorageAdapter(inner: StorageAdapter, logger: Logger): StorageAdapter {
  const log = logger.child({ component: "sync" });
  let blocksProcessed = 0;
  let eventsSinceLastSummary = 0;
  const eventCountsSinceLastSummary: Record<string, number> = {};

  return async (block: StorageAdapterBlock): Promise<void> => {
    const { blockNumber, logs } = block;

    if (logs.length > 0) {
      const eventCounts: Record<string, number> = {};
      for (const entry of logs) {
        const name = entry.eventName ?? "unknown";
        eventCounts[name] = (eventCounts[name] ?? 0) + 1;
        eventCountsSinceLastSummary[name] = (eventCountsSinceLastSummary[name] ?? 0) + 1;
      }

      log.debug("block processed", { blockNumber, events: logs.length, eventCounts });
    }

    eventsSinceLastSummary += logs.length;
    blocksProcessed++;

    if (blocksProcessed % 1000 === 0) {
      log.info("sync progress", {
        blockNumber,
        blocksProcessed,
        eventsSinceLast: eventsSinceLastSummary,
        eventCounts: { ...eventCountsSinceLastSummary },
      });
      eventsSinceLastSummary = 0;
      for (const key in eventCountsSinceLastSummary) delete eventCountsSinceLastSummary[key];
    }

    return inner(block);
  };
}
