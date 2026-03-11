import { Middleware } from "koa";
import { Observable, Subscription } from "rxjs";
import { input } from "@latticexyz/store-sync/indexer-client";
import { StorageAdapterBlock, StorageAdapterLog } from "@latticexyz/store-sync";
import { debug as parentDebug, error } from "../debug";

const debug = parentDebug.extend("logs-live");

type LogsLiveOptions = {
  storedBlockLogs$: Observable<StorageAdapterBlock>;
};

function bigIntSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function logsLive({ storedBlockLogs$ }: LogsLiveOptions): Middleware {
  return async function logsLiveMiddleware(ctx, next) {
    if (ctx.method !== "GET" || ctx.path !== "/api/logs-live") {
      return next();
    }

    let parsedInput: ReturnType<typeof input.parse>;
    try {
      const rawInput = typeof ctx.query.input === "string" ? ctx.query.input : undefined;
      if (!rawInput) {
        ctx.status = 400;
        ctx.type = "application/json";
        ctx.body = JSON.stringify({ error: "Missing required query parameter: input" });
        return;
      }
      parsedInput = input.parse(JSON.parse(rawInput));
    } catch (e) {
      error("invalid input parameter: %s", e instanceof Error ? e.message : String(e));
      ctx.status = 400;
      ctx.type = "application/json";
      ctx.body = JSON.stringify({
        error: `Invalid input parameter: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    const rawBlockNum = typeof ctx.query.block_num === "string" ? ctx.query.block_num : undefined;
    if (rawBlockNum == null) {
      ctx.status = 400;
      ctx.type = "application/json";
      ctx.body = JSON.stringify({ error: "Missing required query parameter: block_num" });
      return;
    }

    let blockNum: bigint;
    try {
      blockNum = BigInt(rawBlockNum);
    } catch {
      ctx.status = 400;
      ctx.type = "application/json";
      ctx.body = JSON.stringify({ error: `Invalid block_num: ${rawBlockNum}` });
      return;
    }

    const { address, filters } = parsedInput;

    debug("client connected (address=%s, filters=%d, fromBlock=%s)", address ?? "*", filters.length, blockNum);

    ctx.respond = false;
    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let subscription: Subscription | undefined;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    let closeResolve: (() => void) | undefined;

    function cleanup(): void {
      subscription?.unsubscribe();
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      subscription = undefined;
      heartbeatInterval = undefined;
      closeResolve?.();
    }

    ctx.req.once("close", () => {
      debug("client disconnected (address=%s)", address ?? "*");
      cleanup();
    });

    heartbeatInterval = setInterval(() => {
      ctx.res.write(":heartbeat\n\n");
    }, 30_000);

    subscription = storedBlockLogs$.subscribe({
      next: (block) => {
        if (block.blockNumber < blockNum) return;

        let logs: readonly StorageAdapterLog[] = block.logs;

        if (address) {
          logs = logs.filter((log) => log.address?.toLowerCase() === address.toLowerCase());
        }

        if (filters.length > 0) {
          logs = logs.filter((log) =>
            filters.some(
              (f) =>
                log.args?.tableId === f.tableId &&
                (!f.key0 || log.args?.keyTuple?.[0] === f.key0) &&
                (!f.key1 || log.args?.keyTuple?.[1] === f.key1),
            ),
          );
        }

        if (logs.length === 0) return;

        const frame: { blockNumber: string; logs: readonly StorageAdapterLog[] } = {
          blockNumber: block.blockNumber.toString(),
          logs,
        };
        debug("emitting block %s with %d logs (address=%s)", block.blockNumber, logs.length, address ?? "*");
        ctx.res.write(`data: ${bigIntSafeStringify(frame)}\n\n`);
      },
      error: (err) => {
        error("stream error (address=%s): %O", address ?? "*", err);
        ctx.res.end();
        cleanup();
      },
    });

    await new Promise<void>((resolve) => {
      closeResolve = resolve;
      if (!subscription) resolve();
    });
  };
}
