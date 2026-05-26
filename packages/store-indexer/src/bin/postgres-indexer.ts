#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { combineLatest, filter, first, tap } from "rxjs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  cleanDatabase,
  createStorageAdapter,
  shouldCleanDatabase,
  tables as mudTables,
} from "@latticexyz/store-sync/postgres";
import { createStoreSync } from "@latticexyz/store-sync";
import { indexerEnvSchema, parseEnv } from "./parseEnv";
import { getClientOptions } from "./getClientOptions";
import { Block } from "viem";
import { getBlock, getChainId } from "viem/actions";
import { getRpcClient } from "@latticexyz/block-logs-stream";
import { createReorgSafeStorageAdapter } from "../postgres/createReorgSafeStorageAdapter";
import { createLoggingStorageAdapter } from "../createLoggingStorageAdapter";
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
    }),
  ),
);

const { values: cliArgs } = parseArgs({
  options: {
    backfill: { type: "string" },
  },
  strict: false,
});

const backfillRange = (() => {
  if (typeof cliArgs.backfill !== "string") return null;
  const match = /^(\d+)-(\d+)$/.exec(cliArgs.backfill);
  if (!match) throw new Error(`Invalid --backfill range: ${cliArgs.backfill} (expected "FROM-TO")`);
  const from = BigInt(match[1]);
  const to = BigInt(match[2]);
  if (from > to) throw new Error(`Invalid --backfill range: FROM (${from}) > TO (${to})`);
  return { from, to };
})();

logger.info("starting postgres-indexer", { version: packageJson.version });
if (backfillRange) {
  logger.info("backfill mode active — live checkpoint will NOT advance", {
    from: backfillRange.from.toString(),
    to: backfillRange.to.toString(),
  });
}

const clientOptions = await getClientOptions(env);
const publicClient = getRpcClient(clientOptions);
const chainId = await getChainId(publicClient);
const database = drizzle(
  postgres(env.DATABASE_URL, {
    prepare: false,
    onnotice: (notice) => logger.debug(notice.message, { component: "postgres", code: notice.code }),
  }),
);

if (!backfillRange && (await shouldCleanDatabase(database, chainId))) {
  logger.info("outdated database detected, clearing data to start fresh");
  await cleanDatabase(database);
}

let isCaughtUp = false;
let healthcheckStarted = false;

async function getLatestStoredBlockNumber(configTable: (typeof mudTables)["configTable"]): Promise<bigint | undefined> {
  try {
    const chainState = await database
      .select()
      .from(configTable)
      .where(eq(configTable.chainId, chainId))
      .limit(1)
      .execute()
      .then((rows) => rows.find(() => true));
    return chainState?.blockNumber;
  } catch (error) {
    // table may not exist yet
  }
}

async function getDistanceFromFollowBlock(configTable: (typeof mudTables)["configTable"]): Promise<bigint> {
  const [latestStoredBlockNumber, latestFollowBlock] = await Promise.all([
    getLatestStoredBlockNumber(configTable),
    getBlock(publicClient, { blockTag: env.FOLLOW_BLOCK_TAG }),
  ]);
  return latestFollowBlock.number - (latestStoredBlockNumber ?? -1n);
}

async function startSync(): Promise<void> {
  const { storageAdapter, tables } = await createStorageAdapter({
    ...clientOptions,
    database,
    backfillMode: backfillRange != null,
  });

  const loggingAdapter = createLoggingStorageAdapter(storageAdapter, logger);

  const finalAdapter = env.REORG_SAFE
    ? await createReorgSafeStorageAdapter({
        storageAdapter: loggingAdapter,
        database,
        publicClient,
        reorgWindow: env.REORG_WINDOW,
        decoded: false,
      })
    : loggingAdapter;

  if (env.REORG_SAFE) {
    logger.info("reorg-safe enabled", { component: "reorg", window: env.REORG_WINDOW });
  }

  let startBlock: bigint;
  if (backfillRange) {
    startBlock = backfillRange.from;
    logger.info("backfill starting from block", { blockNumber: startBlock });
  } else {
    const latestStoredBlockNumber = await getLatestStoredBlockNumber(tables.configTable);
    startBlock = env.START_BLOCK;
    if (latestStoredBlockNumber != null) {
      startBlock = latestStoredBlockNumber + 1n;
      logger.info("resuming from block", { blockNumber: startBlock });
    }
  }

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

  if (backfillRange) {
    storedBlockLogs$
      .pipe(
        filter(({ blockNumber }) => blockNumber >= backfillRange.to),
        first(),
      )
      .subscribe(({ blockNumber }) => {
        logger.info("backfill complete, exiting", { blockNumber: blockNumber.toString() });
        process.exit(0);
      });
  }

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
    const { healthcheck } = await import("../koa-middleware/healthcheck");
    const { metrics } = await import("../koa-middleware/metrics");
    const { helloWorld } = await import("../koa-middleware/helloWorld");
    const { logsLive } = await import("../koa-middleware/logsLive");

    const server = new Koa();

    server.use(cors());
    server.use(logsLive({ storedBlockLogs$ }));
    server.use(
      healthcheck({
        isReady: () => isCaughtUp,
      }),
    );
    server.use(
      metrics({
        isHealthy: () => true,
        isReady: () => isCaughtUp,
        getLatestStoredBlockNumber: () => getLatestStoredBlockNumber(tables.configTable),
        getDistanceFromFollowBlock: () => getDistanceFromFollowBlock(tables.configTable),
        followBlockTag: env.FOLLOW_BLOCK_TAG,
      }),
    );
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
