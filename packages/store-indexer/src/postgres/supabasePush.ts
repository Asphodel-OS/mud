import type { Sql } from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type Hex, hexToBigInt, hexToBytes, hexToNumber, sliceHex } from "viem";
import { StorageAdapter, StorageAdapterBlock, StorageAdapterLog } from "@latticexyz/store-sync";
import { transformSchemaName } from "@latticexyz/store-sync/postgres";
import { logger } from "../logger";

const log = logger.child({ component: "supabase-push" });
const mudSchemaName = transformSchemaName("mud");

/**
 * Per-block context handed to each projector.
 */
export type ProjectorContext = {
  /** Service-role client (bypasses RLS — backend only, never the browser). */
  supabase: SupabaseClient;
  /** The block whose logs are being processed. */
  blockNumber: number;
  /**
   * Read at publish time. Projectors should mirror durable rows always but only
   * emit user-facing side effects (e.g. announcements) once this is true, so
   * historical catch-up doesn't replay them.
   */
  isCaughtUp: () => boolean;
};

/**
 * A projector turns specific on-chain table writes (decoded straight from
 * `block.logs`, never from the DB) into Supabase rows. Adding a new feed =
 * adding a new projector — the funnel below is generic over event type and
 * destination table. Implementations MUST be idempotent: logs replay on reorg
 * and on a fresh catch-up.
 */
export interface Projector {
  readonly name: string;
  onBlock(logs: readonly StorageAdapterLog[], ctx: ProjectorContext): Promise<void>;
}

/** A `Store_SetRecord` for one table, narrowed to the fields projectors decode. */
export type SetRecord = { keyTuple: readonly Hex[]; staticData: Hex };

/** Every `Store_SetRecord` for `tableId` in this block (offchain tables included). */
export function setRecordsFor(logs: readonly StorageAdapterLog[], tableId: Hex): SetRecord[] {
  const out: SetRecord[] = [];
  for (const l of logs) {
    if (l.eventName !== "Store_SetRecord") continue;
    if (l.args.tableId !== tableId) continue;
    out.push({ keyTuple: l.args.keyTuple, staticData: l.args.staticData });
  }
  return out;
}

/**
 * First key field as a decimal string. Matches Postgres `id::text` for a
 * `uint256` key (the id format the leaderboard cache + client already use), so
 * ids stay consistent across the read layer.
 */
export function keyToId(rec: SetRecord): string {
  return hexToBigInt(rec.keyTuple[0]).toString();
}

/** Read a static uint field `[offset, offset+len)` from a record's staticData. */
export function readStaticUint(staticData: Hex, offset: number, len: number): number {
  return hexToNumber(sliceHex(staticData, offset, offset + len));
}

/**
 * Probe for `mud.records` BEFORE querying it inside a transaction: the storage
 * adapter only creates the table after first boot, and an errored query inside
 * `sql.begin` aborts the transaction and rethrows out of `begin` regardless of
 * a local catch (see referralRewardsProjection's identical constraint) — so
 * fetchSetRecords' missing-table catch cannot save a transactional caller.
 */
export async function mudRecordsTableExists(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${`"${mudSchemaName}"."records"`}) IS NOT NULL AS "exists"
  `;
  return row?.exists ?? false;
}

/**
 * Hydration-path counterpart to `setRecordsFor`: instead of decoding from a
 * block's logs, reads the current row per `(address, table_id)` straight out of
 * `mud.records`. This is the state the storage adapter has already rolled back
 * to the common ancestor before a reorg restart, so it's safe to seed
 * in-process caches from it on boot. Mirrors `fetchRawReferralRewardRows` in
 * `referralRewardsProjection.ts`, including its missing-table fail-open.
 */
export async function fetchSetRecords(sql: Sql, storeAddress: Hex, tableId: Hex): Promise<SetRecord[]> {
  try {
    const rows = await sql<{ keyBytes: Hex; staticData: Hex }[]>`
      SELECT '0x' || encode(key_bytes, 'hex') AS "keyBytes", '0x' || encode(static_data, 'hex') AS "staticData"
      FROM ${sql(`${mudSchemaName}.records`)}
      WHERE address = ${hexToBytes(storeAddress)}
        AND table_id = ${hexToBytes(tableId)}
        AND is_deleted IS DISTINCT FROM true
        AND static_data IS NOT NULL
    `;
    // All hydrated tables key on a single uint256, so key_bytes IS keyTuple[0].
    return rows.map((row) => ({ keyTuple: [row.keyBytes], staticData: row.staticData }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "3F000") return [];
    throw error;
  }
}

export interface SupabasePushAdapter {
  /**
   * Wrap a storage adapter so each projector runs against the just-written
   * block's logs. Pass-through (no-op) when disabled.
   */
  wrap(inner: StorageAdapter): StorageAdapter;
}

/**
 * createSupabasePushAdapter — the reusable "push funnel". A storage-adapter
 * decorator (same shape as the SQS reveal hook) that, after the durable write
 * lands, runs every registered projector against the block's logs. Each
 * projector captures its events from the chain directly and pushes to Supabase.
 *
 * Disabled (pass-through) unless the flag is on, both creds are present, and at
 * least one projector is registered — so a default deploy is unchanged.
 */
export function createSupabasePushAdapter(opts: {
  enabled: boolean;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  isCaughtUp: () => boolean;
  projectors: Projector[];
}): SupabasePushAdapter {
  if (!opts.enabled || !opts.supabaseUrl || !opts.serviceRoleKey || opts.projectors.length === 0) {
    log.info("disabled", {
      enabled: opts.enabled,
      hasUrl: Boolean(opts.supabaseUrl),
      hasKey: Boolean(opts.serviceRoleKey),
      projectors: opts.projectors.length,
    });
    return { wrap: (inner): StorageAdapter => inner };
  }

  // Service-role client: bypasses RLS, so the default-deny INSERT policy on the
  // tables doesn't apply here. Never expose this key to the browser.
  //
  // supabase-js eagerly builds a RealtimeClient, which resolves a WebSocket
  // constructor at construction time and throws on Node <22 (no global
  // WebSocket). We only use the PostgREST HTTP API and never open a realtime
  // channel, so we hand it an unused transport stub to skip that resolution.
  // The stub is never instantiated because .channel() is never called.
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: class UnusedRealtimeTransport {} as never },
  });

  log.info("enabled", { projectors: opts.projectors.map((p) => p.name) });

  return {
    wrap:
      (inner): StorageAdapter =>
      async (block: StorageAdapterBlock): Promise<void> => {
        await inner(block); // durable decoded write lands first
        const ctx: ProjectorContext = {
          supabase,
          blockNumber: Number(block.blockNumber),
          isCaughtUp: opts.isCaughtUp,
        };
        for (const projector of opts.projectors) {
          try {
            await projector.onBlock(block.logs, ctx);
          } catch (e) {
            // Isolated: one projector's failure (or a Supabase outage) must never
            // propagate out of the adapter and stall/crash the indexer — the
            // durable Postgres write already landed.
            log.error("projector failed", {
              projector: projector.name,
              block: ctx.blockNumber,
              supabaseUrl: opts.supabaseUrl,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      },
  };
}
