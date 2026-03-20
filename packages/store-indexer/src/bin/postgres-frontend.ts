#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import Koa from "koa";
import cors from "@koa/cors";
import { createKoaMiddleware } from "trpc-koa-adapter";
import { createAppRouter } from "@latticexyz/store-sync/trpc-indexer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import bodyParser from "koa-bodyparser";
import { frontendEnvSchema, parseEnv } from "./parseEnv";
import { createQueryAdapter } from "../postgres/deprecated/createQueryAdapter";
import { apiRoutes } from "../postgres/apiRoutes";
import { sentry } from "../koa-middleware/sentry";
import { healthcheck } from "../koa-middleware/healthcheck";
import { helloWorld } from "../koa-middleware/helloWorld";
import { metrics } from "../koa-middleware/metrics";
import { logsLive } from "../koa-middleware/logsLive";
import { createBlockLogsStream } from "../postgres/createBlockLogsStream";

const env = parseEnv(
  z.intersection(
    frontendEnvSchema,
    z.object({
      DATABASE_URL: z.string(),
      SENTRY_DSN: z.string().optional(),
      POLLING_INTERVAL: z.coerce.number().positive().default(1000),
      QUERY_API_KEY: z.string().optional(),
    }),
  ),
);

const database = postgres(env.DATABASE_URL, { prepare: false });

const storedBlockLogs$ = createBlockLogsStream({
  sql: database,
  pollingIntervalMs: env.POLLING_INTERVAL,
});

const server = new Koa();

if (env.SENTRY_DSN) {
  server.use(sentry(env.SENTRY_DSN));
}

server.use(cors());
server.use(logsLive({ storedBlockLogs$ }));
server.use(healthcheck());
server.use(
  metrics({
    isHealthy: () => true,
    isReady: () => true,
  }),
);
server.use(helloWorld());
server.use(bodyParser());
server.use(apiRoutes({ database, queryApiKey: env.QUERY_API_KEY }));

server.use(
  createKoaMiddleware({
    prefix: "/trpc",
    router: createAppRouter(),
    createContext: async () => ({
      queryAdapter: await createQueryAdapter(drizzle(database)),
    }),
  }),
);

server.listen({ host: env.HOST, port: env.PORT });
console.log(`postgres indexer frontend listening on http://${env.HOST}:${env.PORT}`);

if (env.QUERY_API_KEY) {
  console.warn("\n\n⚠️  SECURITY WARNING ⚠️");
  console.warn("=========================\n");
  console.warn("QUERY API ENDPOINT IS ENABLED (POST /q)");
  console.warn("This exposes raw SQL query execution behind an API key.");
  console.warn("Ensure QUERY_API_KEY is strong and rotated regularly.");
  console.warn("\n=========================\n\n");
}
