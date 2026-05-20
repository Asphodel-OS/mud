import { Sql } from "postgres";
import { Middleware } from "koa";
import Router from "@koa/router";
import compose from "koa-compose";
import { input } from "@latticexyz/store-sync/indexer-client";
import { schemasTable } from "@latticexyz/store-sync";
import { queryLogs } from "./queryLogs";
import { recordToLog } from "./recordToLog";
import { debug, error } from "../debug";
import { logger } from "../logger";
import { createBenchmark } from "@latticexyz/common";
import { compress } from "../koa-middleware/compress";
import type { LeaderboardCache } from "./aggregateCache";

const log = logger.child({ component: "api-logs" });

// bigint-safe JSON: ids serialize to strings. The cache's byWallet/byTaruchi
// Maps are never passed in here (we send plain arrays only).
const jsonBigint = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function apiRoutes(database: Sql, leaderboardCache: LeaderboardCache): Middleware {
  const router = new Router();

  // Server-side aggregated leaderboard (trainers + per-taruchi + ascended).
  // 503 until the first cache build succeeds — never serve an empty board as valid.
  router.get("/api/leaderboard", compress(), async (ctx) => {
    if (!leaderboardCache.isReady()) {
      ctx.status = 503;
      ctx.set("Content-Type", "application/json");
      ctx.body = JSON.stringify({ error: "leaderboard cache warming up" });
      return;
    }
    const agg = leaderboardCache.getAggregate();
    ctx.status = 200;
    ctx.set("Content-Type", "application/json");
    ctx.body = jsonBigint({
      overall: agg.overall,
      overallByTaruchi: agg.overallByTaruchi,
      ascended: agg.ascended,
      recordCount: agg.recordCount,
      computedAt: agg.computedAt,
    });
  });

  // One trainer's stats row + full roster (all owned tarus incl. zero-match).
  router.get("/api/trainer/:wallet", compress(), async (ctx) => {
    if (!leaderboardCache.isReady()) {
      ctx.status = 503;
      ctx.set("Content-Type", "application/json");
      ctx.body = JSON.stringify({ error: "leaderboard cache warming up" });
      return;
    }
    const wallet = String(ctx.params.wallet ?? "");
    ctx.status = 200;
    ctx.set("Content-Type", "application/json");
    ctx.body = jsonBigint({
      wallet: wallet.toLowerCase(),
      stats: leaderboardCache.getStats(wallet),
      roster: leaderboardCache.getRoster(wallet),
      computedAt: leaderboardCache.computedAt(),
    });
  });

  router.get("/api/logs", compress(), async (ctx) => {
    const benchmark = createBenchmark("postgres:logs");
    let options: ReturnType<typeof input.parse>;

    try {
      options = input.parse(typeof ctx.query.input === "string" ? JSON.parse(ctx.query.input) : {});
    } catch (e) {
      ctx.status = 400;
      ctx.set("Content-Type", "application/json");
      ctx.body = JSON.stringify(e);
      debug(e);
      return;
    }

    log.info("request received", {
      chainId: options.chainId,
      address: options.address ?? "*",
      filters: options.filters.length,
    });

    try {
      options.filters = options.filters.length > 0 ? [...options.filters, { tableId: schemasTable.tableId }] : [];
      const records = await queryLogs(database, options ?? {}).execute();
      benchmark("query records");
      const logs = records.map(recordToLog);
      benchmark("map records to logs");

      // Ideally we would immediately return an error if the request is for a Store that the indexer
      // is not configured to index. Since we don't have easy access to this information here,
      // we return an error if there are no logs found for a given Store, since that would never
      // be the case for a Store that is being indexed (since there would at least be records for the
      // Tables table with tables created during Store initialization).
      if (records.length === 0) {
        ctx.status = 404;
        ctx.body = "no logs found";
        error(
          `no logs found for chainId ${options.chainId}, address ${options.address}, filters ${JSON.stringify(
            options.filters,
          )}`,
        );
        return;
      }

      const blockNumber = records[0].chainBlockNumber;
      ctx.status = 200;

      ctx.set("Content-Type", "application/json");
      log.info("response ok", { blockNumber: blockNumber.toString(), logs: logs.length });
      ctx.body = JSON.stringify({ blockNumber, logs });
    } catch (e) {
      debug("request failed:", e);
      ctx.status = 500;
      ctx.set("Content-Type", "application/json");
      ctx.body = JSON.stringify(e);
      error(e);
    }
  });

  return compose([router.routes(), router.allowedMethods()]) as Middleware;
}
