import { Sql } from "postgres";
import { Middleware } from "koa";
import Router from "@koa/router";
import compose from "koa-compose";
import { input } from "@latticexyz/store-sync/indexer-client";
import { schemasTable } from "@latticexyz/store-sync";
import { queryLogs } from "./queryLogs";
import { recordToLog } from "./recordToLog";
import { debug, error } from "../debug";
import { createBenchmark } from "@latticexyz/common";
import { compress } from "../koa-middleware/compress";
import { formatSqlQuery } from "./formatSqlQuery";

type Props = {
  database: Sql;
  queryApiKey?: string;
};

export function apiRoutes({ database, queryApiKey }: Props): Middleware {
  const router = new Router();

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

    debug(
      `request received (chainId=${options.chainId}, address=${options.address}, filters=${options.filters.length})`,
    );

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

      // max age is set to several multiples of the uncached response time (currently ~10s, but using 60s for wiggle room) to ensure only ~one origin request at a time
      // and stale-while-revalidate below means that the cache is refreshed under the hood while still responding fast (cached)
      const maxAgeSeconds = 60 * 5;
      // we set stale-while-revalidate to the time elapsed by the number of blocks we can fetch from the RPC in the same amount of time as an uncached response
      // meaning it would take ~the same about of time to get an uncached response from the origin as it would to catch up from the currently cached response
      // if an uncached response takes ~10 seconds, we have ~10s to catch up, so let's say we can do enough RPC calls to fetch 4000 blocks
      // with a block per 2 seconds, that means we can serve a stale/cached response for 8000 seconds before we should require the response be returned by the origin
      const staleWhileRevalidateSeconds = 4000 * 2;

      ctx.set(
        "Cache-Control",
        `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`,
      );

      ctx.set("Content-Type", "application/json");
      debug(`response ok (blockNumber=${blockNumber}, logs=${logs.length})`);
      ctx.body = JSON.stringify({ blockNumber, logs });
    } catch (e) {
      debug("request failed:", e);
      ctx.status = 500;
      ctx.set("Content-Type", "application/json");
      ctx.body = JSON.stringify(e);
      error(e);
    }
  });

  router.post("/q", async (ctx) => {
    ctx.set("Content-Type", "application/json");

    if (!queryApiKey) {
      ctx.status = 404;
      ctx.body = JSON.stringify({ error: "Query endpoint is not enabled" });
      return;
    }

    if (ctx.get("x-api-key") !== queryApiKey) {
      ctx.status = 401;
      ctx.body = JSON.stringify({ error: "Invalid API key" });
      return;
    }

    try {
      const queries = Array.isArray(ctx.request.body) ? ctx.request.body : [];
      if (queries.length === 0) {
        ctx.status = 400;
        ctx.body = JSON.stringify({ error: "No queries provided" });
        return;
      }

      const result = [];
      for (const entry of queries) {
        if (!entry || typeof entry !== "object" || typeof entry.query !== "string") {
          ctx.status = 400;
          ctx.body = JSON.stringify({ error: "Each query must be an object with a 'query' string property" });
          return;
        }

        const formattedQuery = formatSqlQuery(entry.query);
        const data = await database.unsafe(formattedQuery);

        if (data.length === 0) {
          result.push([]);
          continue;
        }

        const columns = Object.keys(data[0]).map((key) => key.replaceAll("_", "").toLowerCase());
        const rows = data.map((row: Record<string, unknown>) =>
          Object.values(row).map((value) => value?.toString() ?? ""),
        );
        result.push([columns, ...rows]);
      }

      ctx.status = 200;
      ctx.body = JSON.stringify({ result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unknown error occurred";
      ctx.status = 400;
      ctx.body = JSON.stringify({ error: errorMessage });
    }
  });

  return compose([router.routes(), router.allowedMethods()]) as Middleware;
}
