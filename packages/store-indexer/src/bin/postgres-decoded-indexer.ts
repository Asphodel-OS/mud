#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { combineLatest, filter, first, tap } from "rxjs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createStorageAdapter } from "@latticexyz/store-sync/postgres-decoded";
import { tables as mudTables } from "@latticexyz/store-sync/postgres";
import { createStoreSync } from "@latticexyz/store-sync";
import { indexerEnvSchema, parseEnv } from "./parseEnv";
import { sentry } from "../koa-middleware/sentry";
import { healthcheck } from "../koa-middleware/healthcheck";
import { helloWorld } from "../koa-middleware/helloWorld";
import { getClientOptions } from "./getClientOptions";
import { Block } from "viem";
import { getChainId } from "viem/actions";
import { getRpcClient } from "@latticexyz/block-logs-stream";
import { createRevealHookAdapter } from "../sqs-reveal-hook";
import { createReorgSafeStorageAdapter } from "../postgres/createReorgSafeStorageAdapter";
import { createLoggingStorageAdapter } from "../createLoggingStorageAdapter";
import { storeBlockHash } from "../postgres/blockCache";
import { ReorgError } from "../postgres/ReorgError";
import { createSupabasePushAdapter } from "../postgres/supabasePush";
import { createTourneyAnnouncementProjector } from "../postgres/tourneyAnnouncementProjector";
import { createNotificationEventProjector } from "../postgres/notificationEventProjector";
import {
  createReferralRewardProjectionAdapter,
  ensureReferralRewardProjectionTables,
  resetReferralRewardStateFromStoreRecords,
} from "../postgres/referralRewardsProjection";
import { logger, flushLogs } from "../logger";
import { versionInfo } from "../version";

const env = parseEnv(
  z.intersection(
    indexerEnvSchema,
    z.object({
      DATABASE_URL: z.string(),
      HEALTHCHECK_HOST: z.string().optional(),
      HEALTHCHECK_PORT: z.coerce.number().optional(),
      SENTRY_DSN: z.string().optional(),
      SQS_QUEUE_URL: z.string().optional(),
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

logger.info("starting postgres-decoded-indexer", {
  version: versionInfo.version,
  commit: versionInfo.commit,
  build_date: versionInfo.buildDate,
  node: process.version,
});

// Register before the top-level awaits below so a SIGTERM during the initial
// RPC/DB connect still flushes and exits 0 instead of hitting Node's default.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  await flushLogs();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

const clientOptions = await getClientOptions(env);
const publicClient = getRpcClient(clientOptions);
const chainId = await getChainId(publicClient);
const sql = postgres(env.DATABASE_URL, {
  prepare: false,
  onnotice: (notice) => logger.debug(notice.message, { component: "postgres", code: notice.code }),
});
const database = drizzle(sql);

let isCaughtUp = false;
let healthcheckStarted = false;
await ensureReferralRewardProjectionTables(sql);
if (env.STORE_ADDRESS) {
  await resetReferralRewardStateFromStoreRecords(sql, [env.STORE_ADDRESS.toLowerCase()]);
}

// Supabase push funnel: a storage-adapter decorator (same shape as the SQS
// reveal hook) that, after each block's durable write lands, runs its projectors
// against the block's logs. The tourney-announcement projector captures finished
// festivals straight from the chain (no DB read) and mirrors them into Supabase.
// Lives in the indexer (the writer) so it sees the raw logs and never races
// horizontally-scaled frontend replicas. No-op unless the flag + creds are set.
// Announcements are gated on isCaughtUp so historical catch-up doesn't spam chat.
const supabasePush = createSupabasePushAdapter({
  enabled: env.PUBLISH_RESULTS_TO_SUPABASE,
  supabaseUrl: env.SUPABASE_URL,
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  isCaughtUp: () => isCaughtUp,
  projectors: [createTourneyAnnouncementProjector(), createNotificationEventProjector()],
});

async function getStartBlock(configTable: (typeof mudTables)["configTable"]): Promise<bigint> {
  try {
    const chainState = await database
      .select()
      .from(configTable)
      .where(eq(configTable.chainId, chainId))
      .limit(1)
      .execute()
      .then((rows) => rows.find(() => true));

    if (chainState?.blockNumber != null) {
      logger.info("resuming from block", { blockNumber: chainState.blockNumber + 1n });
      return chainState.blockNumber + 1n;
    }
  } catch (error) {
    // table may not exist yet on first run
  }
  return env.START_BLOCK;
}

async function startSync(): Promise<void> {
  const { storageAdapter, tables } = await createStorageAdapter({ ...clientOptions, database });

  const loggingAdapter = createLoggingStorageAdapter(storageAdapter, logger);
  const referralRewardProjection = createReferralRewardProjectionAdapter(sql);
  const referralRewardAdapter = referralRewardProjection.wrap(loggingAdapter);
  // Supabase push funnel wraps the write so its projectors see each block's
  // logs after the durable write lands; pass-through when disabled.
  const supabaseAdapter = supabasePush.wrap(referralRewardAdapter);
  const sqsAdapter = env.SQS_QUEUE_URL ? createRevealHookAdapter(supabaseAdapter, env.SQS_QUEUE_URL) : supabaseAdapter;

  const finalAdapter = env.REORG_SAFE
    ? await createReorgSafeStorageAdapter({
        storageAdapter: sqsAdapter,
        database,
        publicClient,
        reorgWindow: env.REORG_WINDOW,
        decoded: true,
      })
    : sqsAdapter;

  if (env.REORG_SAFE) {
    logger.info("reorg-safe enabled", { component: "reorg", window: env.REORG_WINDOW });
  }
  if (env.SQS_QUEUE_URL) {
    logger.info("sqs-reveal-hook enabled", { component: "sqs", queue: env.SQS_QUEUE_URL });
  }

  const startBlock = await getStartBlock(tables.configTable);

  const { latestBlock$, latestBlockNumber$, storedBlockLogs$ } = await createStoreSync({
    ...clientOptions,
    storageAdapter: finalAdapter,
    followBlockTag: env.FOLLOW_BLOCK_TAG,
    startBlock,
    maxBlockRange: env.MAX_BLOCK_RANGE,
    address: env.STORE_ADDRESS,
  });

  if (env.REORG_SAFE) {
    latestBlock$
      .pipe(
        tap(async (block: Block) => {
          try {
            if (block.hash && block.number != null) {
              await storeBlockHash(database, block.number, block.hash);
            }
          } catch (e) {
            logger.warn("failed to store block hash from stream", { component: "reorg", error: e });
          }
        }),
      )
      .subscribe();
  }

  storedBlockLogs$.subscribe();

  isCaughtUp = false;
  combineLatest([latestBlockNumber$, storedBlockLogs$])
    .pipe(
      filter(
        ([latestBlockNumber, { blockNumber: lastBlockNumberProcessed }]) =>
          latestBlockNumber === lastBlockNumberProcessed,
      ),
      first(),
    )
    .subscribe(() => {
      isCaughtUp = true;
      logger.info("all caught up");
    });

  if (!healthcheckStarted && (env.HEALTHCHECK_HOST != null || env.HEALTHCHECK_PORT != null)) {
    healthcheckStarted = true;
    const { default: Koa } = await import("koa");
    const { default: cors } = await import("@koa/cors");
    const { logsLive } = await import("../koa-middleware/logsLive");

    const server = new Koa();

    if (env.SENTRY_DSN) {
      server.use(sentry(env.SENTRY_DSN));
    }

    server.use(cors());
    server.use(logsLive({ storedBlockLogs$ }));
    server.use(healthcheck({ isReady: () => isCaughtUp }));
    server.use(helloWorld());

    server.listen({ host: env.HEALTHCHECK_HOST, port: env.HEALTHCHECK_PORT });
    logger.info("healthcheck server listening", { host: env.HEALTHCHECK_HOST, port: env.HEALTHCHECK_PORT });
  }

  return new Promise<void>((_, reject) => {
    storedBlockLogs$.subscribe({
      error: (err: unknown) => reject(err),
    });
  });
}

async function run(): Promise<void> {
  for (;;) {
    try {
      await startSync();
      break;
    } catch (error) {
      if (error instanceof ReorgError) {
        logger.info("restarting sync after reorg", { component: "reorg", blockNumber: error.commonAncestorBlock + 1n });
        continue;
      }
      throw error;
    }
  }
}

run().catch(async (error) => {
  logger.error("fatal error", { error });
  await flushLogs();
  process.exit(1);
});
