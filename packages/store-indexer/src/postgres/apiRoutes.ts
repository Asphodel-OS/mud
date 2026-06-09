import { Sql } from "postgres";
import { Middleware } from "koa";
import Router from "@koa/router";
import compose from "koa-compose";
import { input } from "@latticexyz/store-sync/indexer-client";
import { schemasTable } from "@latticexyz/store-sync";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import type { Address, PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { queryLogs } from "./queryLogs";
import { recordToLog } from "./recordToLog";
import { debug, error } from "../debug";
import { logger } from "../logger";
import { createBenchmark } from "@latticexyz/common";
import { compress } from "../koa-middleware/compress";
import type { LeaderboardCache } from "./aggregateCache";
import {
  isIndexerCaughtUp,
  lookupAscensionRecord,
  parseClaimantParam,
  parseTaruchiIdParam,
  signAscensionRecord,
} from "./ascensionRecordAttestation";

const log = logger.child({ component: "api-logs" });
const mudSchemaName = transformSchemaName("mud");

type AscensionRecordAttestationOptions = {
  signer: PrivateKeyAccount;
  publicClient: PublicClient;
  worldAddress: Address;
  ttlSeconds: number;
  maxLagBlocks: bigint;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  claimantRateLimitMaxRequests: number;
};

type IndexerStateRow = {
  chainId: string;
  indexedBlock: string;
};

type AscensionPrecheckRow = {
  owner: string;
  state: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const TARUCHI_STATE_ASCENDED = 4;

// bigint-safe JSON: ids serialize to strings. The cache's byWallet/byTaruchi
// Maps are never passed in here (we send plain arrays only).
const jsonBigint = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function jsonResponse(ctx: Parameters<Middleware>[0], status: number, body: unknown): void {
  ctx.status = status;
  ctx.set("Content-Type", "application/json");
  ctx.body = jsonBigint(body);
}

async function getIndexerState(database: Sql): Promise<{ chainId: bigint; indexedBlock: bigint }> {
  const rows = await database<IndexerStateRow[]>`
    SELECT chain_id AS "chainId", block_number AS "indexedBlock"
    FROM ${database(`${mudSchemaName}.config`)}
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error("indexer config row missing");
  return { chainId: BigInt(rows[0].chainId), indexedBlock: BigInt(rows[0].indexedBlock) };
}

async function precheckAscensionClaimant(
  database: Sql,
  worldAddress: Address,
  taruchiId: bigint,
): Promise<{ status: "ok"; owner: Address; state: number } | { status: "missing" }> {
  const schema = worldAddress.toLowerCase();
  const rows = await database<AscensionPrecheckRow[]>`
    SELECT '0x' || encode(c.owner, 'hex') AS owner, s.state::int AS state
    FROM ${database(`${schema}.app__taruchi_core`)} c
    JOIN ${database(`${schema}.app__taruchi_status`)} s ON s.id = c.id
    WHERE c.id = ${taruchiId.toString()}
    LIMIT 1
  `;
  if (rows.length === 0) return { status: "missing" };
  return { status: "ok", owner: rows[0].owner as Address, state: Number(rows[0].state) };
}

function checkRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  now: number,
  windowMs: number,
  maxRequests: number,
): { limited: false } | { limited: true; retryAfterSeconds: number } {
  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false };
  }
  if (existing.count >= maxRequests) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  return { limited: false };
}

function requestIdentity(ctx: Parameters<Middleware>[0]): string {
  const forwardedForParts = ctx
    .get("x-forwarded-for")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const proxyAppendedIp = forwardedForParts[forwardedForParts.length - 1];
  return proxyAppendedIp || ctx.ip || ctx.request.ip || "unknown";
}

export function apiRoutes(
  database: Sql,
  leaderboardCache: LeaderboardCache,
  ascensionAttestation?: AscensionRecordAttestationOptions,
): Middleware {
  const router = new Router();
  const requestBuckets = new Map<string, RateLimitBucket>();
  const claimantBuckets = new Map<string, RateLimitBucket>();

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

  // One trainer's finished matches (newest first) for the Mine archive.
  // Summaries only; full replay loads on click via keyed /api/logs (matchId).
  router.get("/api/trainer/:wallet/battles", compress(), async (ctx) => {
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
      battles: leaderboardCache.getBattles(wallet),
      computedAt: leaderboardCache.computedAt(),
    });
  });

  // One taruchi's full detail by onchain uint256 id, not visible roster index.
  // Fighter Card payload: onchain status + unpacked
  // combat stats/traits + lifetime record + per-tier W/L + ascension flag.
  // Served from the same per-block aggregate cache as the leaderboard, so it's
  // an O(1) in-memory lookup with no per-request DB query.
  router.get("/api/taruchi/:id", compress(), async (ctx) => {
    if (!leaderboardCache.isReady()) {
      jsonResponse(ctx, 503, { error: "leaderboard cache warming up" });
      return;
    }
    const taruchiId = parseTaruchiIdParam(String(ctx.params.id ?? ""));
    if (taruchiId === null) {
      jsonResponse(ctx, 400, { error: "invalid taruchi id" });
      return;
    }
    const detail = leaderboardCache.getTaruchi(taruchiId.toString());
    if (!detail) {
      jsonResponse(ctx, 404, { error: "taruchi not found" });
      return;
    }
    jsonResponse(ctx, 200, { ...detail, computedAt: leaderboardCache.computedAt() });
  });

  // Fresh signed W/L record for ascension NFT claims. This uses the same
  // aggregate as Rankings/TFC (duels + Festival sub-battles), binds the
  // signature to the current indexed owner, forces an immediate rebuild, and
  // refuses to sign if the decoded DB is behind RPC head.
  router.get("/api/taruchi/:taruchiId/ascension-record-attestation", compress(), async (ctx) => {
    if (!ascensionAttestation) {
      jsonResponse(ctx, 503, { error: "ascension attestation signer not configured" });
      return;
    }

    const taruchiId = parseTaruchiIdParam(String(ctx.params.taruchiId ?? ""));
    if (taruchiId === null) {
      jsonResponse(ctx, 400, { error: "invalid taruchi id" });
      return;
    }
    const claimant = parseClaimantParam(typeof ctx.query.claimant === "string" ? ctx.query.claimant : undefined);
    if (claimant === null) {
      jsonResponse(ctx, 400, { error: "invalid claimant address" });
      return;
    }

    const now = Date.now();
    const requesterLimit = checkRateLimit(
      requestBuckets,
      requestIdentity(ctx),
      now,
      ascensionAttestation.rateLimitWindowMs,
      ascensionAttestation.rateLimitMaxRequests,
    );
    if (requesterLimit.limited) {
      ctx.set("Retry-After", requesterLimit.retryAfterSeconds.toString());
      jsonResponse(ctx, 429, { error: "too many ascension attestation requests" });
      return;
    }
    const claimantLimit = checkRateLimit(
      claimantBuckets,
      claimant.toLowerCase(),
      now,
      ascensionAttestation.rateLimitWindowMs,
      ascensionAttestation.claimantRateLimitMaxRequests,
    );
    if (claimantLimit.limited) {
      ctx.set("Retry-After", claimantLimit.retryAfterSeconds.toString());
      jsonResponse(ctx, 429, { error: "too many ascension attestation requests for claimant" });
      return;
    }

    try {
      const precheck = await precheckAscensionClaimant(database, ascensionAttestation.worldAddress, taruchiId);
      if (precheck.status === "missing" || precheck.state !== TARUCHI_STATE_ASCENDED) {
        jsonResponse(ctx, 404, { error: "taruchi is not ascended in indexed state" });
        return;
      }
      if (precheck.owner.toLowerCase() !== claimant.toLowerCase()) {
        jsonResponse(ctx, 403, {
          error: "claimant is not the indexed taruchi owner",
          owner: precheck.owner.toLowerCase(),
          claimant,
        });
        return;
      }
    } catch (e) {
      log.error("ascension attestation precheck failed", {
        taruchiId: taruchiId.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
      jsonResponse(ctx, 503, { error: "indexer ascension precheck failed" });
      return;
    }

    try {
      await leaderboardCache.rebuildNow();
    } catch (e) {
      log.error("ascension attestation aggregate rebuild failed", {
        taruchiId: taruchiId.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
      jsonResponse(ctx, 503, { error: "leaderboard aggregate rebuild failed" });
      return;
    }

    if (!leaderboardCache.isReady()) {
      jsonResponse(ctx, 503, { error: "leaderboard cache warming up" });
      return;
    }
    const aggregateIndexedBlock = leaderboardCache.indexedBlock();

    let chainId: bigint;
    let indexedBlock: bigint;
    let headBlock: bigint;
    try {
      const state = await getIndexerState(database);
      chainId = state.chainId;
      indexedBlock = state.indexedBlock;
      headBlock = await ascensionAttestation.publicClient.getBlockNumber();
    } catch (e) {
      log.error("ascension attestation freshness check failed", {
        taruchiId: taruchiId.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
      jsonResponse(ctx, 503, { error: "indexer freshness check failed" });
      return;
    }

    if (aggregateIndexedBlock === null || aggregateIndexedBlock !== indexedBlock) {
      jsonResponse(ctx, 409, {
        error: "leaderboard aggregate changed during ascension attestation; retry",
        aggregateIndexedBlock,
        indexedBlock,
      });
      return;
    }

    const lag = headBlock > indexedBlock ? headBlock - indexedBlock : 0n;
    if (!isIndexerCaughtUp(indexedBlock, headBlock, ascensionAttestation.maxLagBlocks)) {
      jsonResponse(ctx, 409, {
        error: `indexer lagging behind RPC head by ${lag.toString()} block(s)`,
        indexedBlock,
        headBlock,
        maxLagBlocks: ascensionAttestation.maxLagBlocks,
      });
      return;
    }

    const chainIdNumber = Number(chainId);
    if (!Number.isSafeInteger(chainIdNumber)) {
      jsonResponse(ctx, 500, { error: "indexed chain id is not safely representable" });
      return;
    }

    const lookup = lookupAscensionRecord(leaderboardCache.getAggregate(), taruchiId, chainIdNumber, claimant);
    if (lookup.status === "not-ascended") {
      jsonResponse(ctx, 404, { error: "taruchi is not ascended in indexed state" });
      return;
    }
    if (lookup.status === "record-missing") {
      jsonResponse(ctx, 409, { error: "ascended taruchi record is missing from aggregate" });
      return;
    }
    if (lookup.status === "claimant-mismatch") {
      jsonResponse(ctx, 403, {
        error: "claimant is not the indexed taruchi owner",
        owner: lookup.owner,
        claimant: lookup.claimant,
      });
      return;
    }
    if (lookup.status === "record-out-of-range") {
      jsonResponse(ctx, 409, {
        error: "ascension record is outside uint32 range",
        wins: lookup.wins,
        losses: lookup.losses,
      });
      return;
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + ascensionAttestation.ttlSeconds);
    let signature: `0x${string}`;
    try {
      signature = await signAscensionRecord({
        signer: ascensionAttestation.signer,
        chainId: chainIdNumber,
        worldAddress: ascensionAttestation.worldAddress,
        record: lookup.record,
        deadline,
      });
    } catch (e) {
      log.error("ascension record signing failed", {
        taruchiId: taruchiId.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
      jsonResponse(ctx, 500, { error: "ascension record signing failed" });
      return;
    }

    try {
      const postSignState = await getIndexerState(database);
      const postSignHeadBlock = await ascensionAttestation.publicClient.getBlockNumber();
      const postSignLag =
        postSignHeadBlock > postSignState.indexedBlock ? postSignHeadBlock - postSignState.indexedBlock : 0n;
      if (!isIndexerCaughtUp(postSignState.indexedBlock, postSignHeadBlock, ascensionAttestation.maxLagBlocks)) {
        jsonResponse(ctx, 409, {
          error: `indexer lagging behind RPC head by ${postSignLag.toString()} block(s)`,
          indexedBlock: postSignState.indexedBlock,
          headBlock: postSignHeadBlock,
          maxLagBlocks: ascensionAttestation.maxLagBlocks,
        });
        return;
      }
      // The signature covers the record, not a block number. Refuse if either
      // the decoded DB or cache moved after lookup/signing.
      const currentAggregateIndexedBlock = leaderboardCache.indexedBlock();
      if (
        currentAggregateIndexedBlock !== aggregateIndexedBlock ||
        postSignState.indexedBlock !== aggregateIndexedBlock
      ) {
        jsonResponse(ctx, 409, {
          error: "leaderboard aggregate changed during ascension attestation; retry",
          aggregateIndexedBlock: currentAggregateIndexedBlock,
          signedAggregateIndexedBlock: aggregateIndexedBlock,
          indexedBlock: postSignState.indexedBlock,
        });
        return;
      }
      headBlock = postSignHeadBlock;
    } catch (e) {
      log.error("ascension attestation post-sign freshness check failed", {
        taruchiId: taruchiId.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
      jsonResponse(ctx, 503, { error: "indexer freshness check failed" });
      return;
    }

    jsonResponse(ctx, 200, {
      taruchiId: lookup.record.taruchiId,
      claimant: lookup.record.claimant,
      wins: lookup.record.wins,
      losses: lookup.record.losses,
      deadline,
      signature,
      signer: ascensionAttestation.signer.address,
      indexedBlock: aggregateIndexedBlock,
      headBlock,
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
