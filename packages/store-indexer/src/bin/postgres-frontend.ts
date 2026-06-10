#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import { createPrivyRecipientVerifier } from "../postgres/privyRecipientVerifier";
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
      // Optional: enables /api/taruchi/:id/ascension-record-attestation?claimant=0x...&recipient=0x...
      // When set, RPC_HTTP_URL is required so the endpoint can refuse stale indexer state.
      RPC_HTTP_URL: z.string().optional(),
      ASCENSION_RECORD_SIGNER_PRIVATE_KEY: z
        .string()
        .optional()
        .transform((input) => (input === "" ? undefined : input))
        .refine(
          (input): input is Hex | undefined => input === undefined || (isHex(input) && input.length === 66),
          "ASCENSION_RECORD_SIGNER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex private key",
        ),
      ASCENSION_RECORD_ATTESTATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
      ASCENSION_RECORD_MAX_LAG_BLOCKS: z.coerce.bigint().nonnegative().default(0n),
      ASCENSION_RECORD_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
      ASCENSION_RECORD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
      ASCENSION_RECORD_CLAIMANT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(6),
      PRIVY_APP_ID: z
        .string()
        .optional()
        .transform((input) => (input === "" ? undefined : input)),
      PRIVY_APP_SECRET: z
        .string()
        .optional()
        .transform((input) => (input === "" ? undefined : input)),
    }),
  ),
);

if (env.ASCENSION_RECORD_SIGNER_PRIVATE_KEY && !env.RPC_HTTP_URL) {
  logger.error("RPC_HTTP_URL is required when ASCENSION_RECORD_SIGNER_PRIVATE_KEY is set");
  process.exit(1);
}

if (env.ASCENSION_RECORD_SIGNER_PRIVATE_KEY && !isAddress(env.STORE_ADDRESS)) {
  logger.error("STORE_ADDRESS must be an address when ascension record signing is enabled");
  process.exit(1);
}

if ((env.PRIVY_APP_ID && !env.PRIVY_APP_SECRET) || (!env.PRIVY_APP_ID && env.PRIVY_APP_SECRET)) {
  logger.error("PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together");
  process.exit(1);
}

const ascensionAttestation = env.ASCENSION_RECORD_SIGNER_PRIVATE_KEY
  ? {
      signer: privateKeyToAccount(env.ASCENSION_RECORD_SIGNER_PRIVATE_KEY),
      publicClient: createPublicClient({ transport: http(env.RPC_HTTP_URL) }),
      worldAddress: env.STORE_ADDRESS as Address,
      ttlSeconds: env.ASCENSION_RECORD_ATTESTATION_TTL_SECONDS,
      maxLagBlocks: env.ASCENSION_RECORD_MAX_LAG_BLOCKS,
      rateLimitWindowMs: env.ASCENSION_RECORD_RATE_LIMIT_WINDOW_SECONDS * 1000,
      rateLimitMaxRequests: env.ASCENSION_RECORD_RATE_LIMIT_MAX_REQUESTS,
      claimantRateLimitMaxRequests: env.ASCENSION_RECORD_CLAIMANT_RATE_LIMIT_MAX_REQUESTS,
      recipientVerifier:
        env.PRIVY_APP_ID && env.PRIVY_APP_SECRET
          ? createPrivyRecipientVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET })
          : undefined,
    }
  : undefined;

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
server.use(apiRoutes(database, leaderboardCache, ascensionAttestation));

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
