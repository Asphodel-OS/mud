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
import { storeBlockHash } from "../postgres/blockCache";
import { ReorgError } from "../postgres/ReorgError";
import { logger } from "../logger";
import packageJson from "../../package.json";

const env = parseEnv(
  z.intersection(
    indexerEnvSchema,
    z.object({
      DATABASE_URL: z.string(),
      HEALTHCHECK_HOST: z.string().optional(),
      HEALTHCHECK_PORT: z.coerce.number().optional(),
      SENTRY_DSN: z.string().optional(),
      SQS_QUEUE_URL: z.string().optional(),
    }),
  ),
);

logger.info("starting postgres-decoded-indexer", { version: packageJson.version });

const clientOptions = await getClientOptions(env);
const publicClient = getRpcClient(clientOptions);
const chainId = await getChainId(publicClient);
const database = drizzle(
  postgres(env.DATABASE_URL, {
    prepare: false,
    onnotice: (notice) => logger.debug(notice.message, { component: "postgres", code: notice.code }),
  }),
);

let isCaughtUp = false;
let healthcheckStarted = false;

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

  const sqsAdapter = env.SQS_QUEUE_URL ? createRevealHookAdapter(storageAdapter, env.SQS_QUEUE_URL) : storageAdapter;

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

run().catch((error) => {
  logger.error("fatal error", { error });
  process.exit(1);
});
