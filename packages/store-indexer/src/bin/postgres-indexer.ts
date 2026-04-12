#!/usr/bin/env node
import "dotenv/config";
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
import { storeBlockHash } from "../postgres/blockCache";
import { ReorgError } from "../postgres/ReorgError";

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

const clientOptions = await getClientOptions(env);
const publicClient = getRpcClient(clientOptions);
const chainId = await getChainId(publicClient);
const database = drizzle(postgres(env.DATABASE_URL, { prepare: false }));

if (await shouldCleanDatabase(database, chainId)) {
  console.log("outdated database detected, clearing data to start fresh");
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
  const { storageAdapter, tables } = await createStorageAdapter({ ...clientOptions, database });

  const finalAdapter = env.REORG_SAFE
    ? await createReorgSafeStorageAdapter({
        storageAdapter,
        database,
        publicClient,
        reorgWindow: env.REORG_WINDOW,
        decoded: false,
      })
    : storageAdapter;

  if (env.REORG_SAFE) {
    console.log(`[reorg-safe] enabled, window: ${env.REORG_WINDOW} blocks`);
  }

  const latestStoredBlockNumber = await getLatestStoredBlockNumber(tables.configTable);
  let startBlock = env.START_BLOCK;
  if (latestStoredBlockNumber != null) {
    startBlock = latestStoredBlockNumber + 1n;
    console.log("resuming from block number", startBlock);
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
            console.warn("[reorg-safe] failed to store block hash from stream", e);
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
      console.log("all caught up");
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
    console.log(
      `postgres indexer healthcheck server listening on http://${env.HEALTHCHECK_HOST}:${env.HEALTHCHECK_PORT}`,
    );
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
        console.log(`[reorg] restarting sync from block ${error.commonAncestorBlock + 1n}`);
        continue;
      }
      throw error;
    }
  }
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
