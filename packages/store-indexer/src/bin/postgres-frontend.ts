#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { isHex, type Hex } from "viem";
import Koa from "koa";
import cors from "@koa/cors";
import { createKoaMiddleware } from "trpc-koa-adapter";
import { createAppRouter } from "@latticexyz/store-sync/trpc-indexer";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { frontendEnvSchema, parseEnv } from "./parseEnv";
import { createQueryAdapter } from "../postgres/deprecated/createQueryAdapter";
import { apiRoutes } from "../postgres/apiRoutes";
import { sentry } from "../koa-middleware/sentry";
import { healthcheck } from "../koa-middleware/healthcheck";
import { helloWorld } from "../koa-middleware/helloWorld";
import { metrics } from "../koa-middleware/metrics";
import { logsLive } from "../koa-middleware/logsLive";
import { createBlockLogsStream } from "../postgres/createBlockLogsStream";
import { createLeaderboardCache } from "../postgres/aggregateCache";
import { createSupabasePublisher } from "../postgres/supabasePublisher";
import { logger } from "../logger";
import packageJson from "../../package.json";

const env = parseEnv(
  z.intersection(
    frontendEnvSchema,
    z.object({
      DATABASE_URL: z.string(),
      SENTRY_DSN: z.string().optional(),
      POLLING_INTERVAL: z.coerce.number().positive().default(1000),
      // Required: the decoded MUD tables live in a Postgres schema named after
      // the lowercased store address. Explicit (not runtime-discovered) so the
      // frontend fails fast if it's missing.
      STORE_ADDRESS: z.string().refine((s): s is Hex => isHex(s), "STORE_ADDRESS must be a 0x-prefixed hex address"),
      // CDN base for taruchi sprite URLs in leaderboard responses. Env-driven so
      // the indexer isn't coupled to a hardcoded (test) CDN.
      TARUCHI_CDN_BASE: z.string().default("https://i.test.kamigotchi.io/taruchi"),
      // Supabase mirror: when enabled, finished festivals are projected into the
      // Supabase tournament_results + announcements tables (service-role write).
      // Off by default so a default deploy is behaviour-equivalent to today.
      SUPABASE_URL: z.string().optional(),
      SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
      // Explicit string parse, NOT z.coerce.boolean() — the latter coerces any
      // non-empty string (incl. "false") to true. Only "true"/"1" enable it.
      PUBLISH_RESULTS_TO_SUPABASE: z
        .string()
        .optional()
        .transform((v) => v === "true" || v === "1"),
    }),
  ),
);

const database = postgres(env.DATABASE_URL, {
  prepare: false,
  onnotice: (notice) => logger.debug(notice.message, { component: "postgres", code: notice.code }),
});

const storedBlockLogs$ = createBlockLogsStream({
  sql: database,
  pollingIntervalMs: env.POLLING_INTERVAL,
});

// Server-side leaderboard/roster cache: built once on startup, recomputed on
// each new block (debounced to <=60s), served pre-aggregated so clients don't
// each pull ~34k+ raw rows. Subscribing to storedBlockLogs$ also keeps the
// shared block poller alive (refCount).
const leaderboardCache = createLeaderboardCache(database, {
  storeAddress: env.STORE_ADDRESS,
  cdnBase: env.TARUCHI_CDN_BASE,
});
leaderboardCache.start(storedBlockLogs$);

// Supabase publisher: mirrors finished festivals into Supabase on the same
// debounced block ticks. No-op unless PUBLISH_RESULTS_TO_SUPABASE is set and
// both Supabase creds are present.
const supabasePublisher = createSupabasePublisher({
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  enabled: env.PUBLISH_RESULTS_TO_SUPABASE,
});
supabasePublisher.start(database, env.STORE_ADDRESS, storedBlockLogs$);

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
server.use(apiRoutes(database, leaderboardCache));

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
logger.info("starting postgres-frontend", { version: packageJson.version, host: env.HOST, port: env.PORT });
