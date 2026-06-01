import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Sql } from "postgres";
import { Observable, Subscription } from "rxjs";
import { type Hex } from "viem";
import { logger } from "../logger";

const log = logger.child({ component: "supabase-publisher" });

/**
 * Festival bracket enum → display name. Mirrors game2's
 * `screens/arena/config.ts` BRACKETS map (the festival entries). mud has no
 * tournament-name column, so the publisher formats the announcement here. Keep
 * in sync with game2 if the festival names ever change.
 */
export const FESTIVAL_NAMES: Record<number, string> = {
  4: "Festival of Consecration",
  5: "Festival of Flowers",
  6: "Ascension Festival",
};

/** The single pre-formatted line stored in `announcements.message`. */
export function formatAnnouncement(name: string): string {
  return `${name} has just finished.`;
}

export type FinishedTournament = {
  tournament_id: string;
  name: string;
  finished_at: string; // ISO 8601
};

/**
 * Tournaments not yet mirrored in Supabase — the exactly-once gate for
 * announcements. Because `tournament_results` persists, a re-tick (or restart)
 * sees the id as existing and emits no duplicate announcement.
 */
export function newAnnouncements(finished: FinishedTournament[], existingIds: Set<string>): FinishedTournament[] {
  return finished.filter((t) => !existingIds.has(t.tournament_id));
}

/**
 * The write half: upsert `tournament_results` + insert `announcements` for the
 * genuinely-new tournaments. Kept separate from the Postgres read for clarity
 * and testability. Throws on a Supabase error.
 */
async function publishToSupabase(
  supabase: SupabaseClient,
  finished: FinishedTournament[],
  currentBlock: number,
): Promise<{ mirrored: number; announced: number }> {
  if (finished.length === 0) return { mirrored: 0, announced: 0 };

  // Which tournaments are already mirrored? Computed BEFORE the upsert so a
  // freshly-mirrored row isn't mistaken for pre-existing (→ no dup announce).
  // Scoped to the current batch (.in) so this never hits PostgREST's default
  // 1000-row select cap, which would otherwise re-announce old festivals.
  const { data: existingRows, error: selErr } = await supabase
    .from("tournament_results")
    .select("tournament_id")
    .in(
      "tournament_id",
      finished.map((t) => t.tournament_id),
    );
  if (selErr) {
    log.error("read existing tournament_results failed", { error: selErr.message });
    throw new Error(selErr.message);
  }
  const existingIds = new Set((existingRows ?? []).map((r) => String(r.tournament_id)));

  // Mirror all finished festivals (idempotent by primary key).
  const { error: upsertErr } = await supabase.from("tournament_results").upsert(
    finished.map((t) => ({ ...t, block_number: currentBlock })),
    { onConflict: "tournament_id" },
  );
  if (upsertErr) {
    log.error("upsert tournament_results failed", { error: upsertErr.message });
    throw new Error(upsertErr.message);
  }

  // One announcement per genuinely-new tournament.
  const fresh = newAnnouncements(finished, existingIds);
  if (fresh.length > 0) {
    const { error: annErr } = await supabase
      .from("announcements")
      .insert(fresh.map((t) => ({ message: formatAnnouncement(t.name) })));
    if (annErr) {
      log.error("insert announcements failed", { error: annErr.message });
      throw new Error(annErr.message);
    }
  }

  return { mirrored: finished.length, announced: fresh.length };
}

export interface SupabasePublisher {
  /** Wire publishing to a block stream (debounced) + publish once on startup. */
  start(database: Sql, storeAddress: Hex, block$: Observable<unknown>): void;
  stop(): void;
}

/**
 * createSupabasePublisher — mirrors finished festivals into Supabase on each
 * debounced block tick, writing both `tournament_results` (durable row) and a
 * pre-formatted `announcements` line in the same tick.
 *
 * Disabled (no-op) unless the flag is on and both Supabase creds are present,
 * so a default frontend deploy is behaviour-equivalent to today.
 */
export function createSupabasePublisher(opts: {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  enabled: boolean;
  debounceMs?: number;
}): SupabasePublisher {
  const debounceMs = opts.debounceMs ?? 60_000;

  if (!opts.enabled || !opts.supabaseUrl || !opts.serviceRoleKey) {
    log.info("disabled", {
      enabled: opts.enabled,
      hasUrl: Boolean(opts.supabaseUrl),
      hasKey: Boolean(opts.serviceRoleKey),
    });
    return { start: (): void => {}, stop: (): void => {} };
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

  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let publishing = false;
  let stopped = false;
  let sub: Subscription | undefined;

  async function publishOnce(sql: Sql, storeAddress: Hex): Promise<void> {
    if (publishing || stopped) return;
    publishing = true;
    try {
      // Decoded MUD tables live in a schema named after the lowercased store
      // address; sql(`schema.table`) quotes it as an identifier.
      const schema = storeAddress.toLowerCase();

      // Finished festivals only: app__tourney (multi-player) joined to its
      // result. status 2 = COMPLETED (mirrors aggregateCache).
      const rows = await sql`
        SELECT t.id::text AS id, t.bracket::int AS bracket, r.time::int AS time
        FROM ${sql(`${schema}.app__tourney`)} t
        JOIN ${sql(`${schema}.app__tourney_result`)} r ON r.id = t.id
        WHERE t.status = 2
      `;

      const finished: FinishedTournament[] = [];
      for (const r of rows) {
        const name = FESTIVAL_NAMES[r.bracket];
        if (name === undefined) continue; // not a known festival → skip
        finished.push({
          tournament_id: r.id,
          name,
          finished_at: new Date(r.time * 1000).toISOString(),
        });
      }

      if (finished.length === 0) {
        log.debug("no finished festivals to publish");
        return;
      }

      // Current indexer block for the informational block_number column.
      const configRows = await sql`
        SELECT block_number FROM ${sql(`${schema}.config`)} LIMIT 1
      `;
      const currentBlock = configRows.length > 0 ? Number(BigInt(configRows[0].block_number)) : 0;

      const { mirrored, announced } = await publishToSupabase(supabase, finished, currentBlock);
      log.info("published", { mirrored, announced, block: currentBlock });
    } catch (e) {
      log.error("publish tick failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      publishing = false;
    }
  }

  // Coalesce block-driven publishes to at most one per debounce window.
  function schedule(sql: Sql, storeAddress: Hex): void {
    if (pendingTimer || publishing || stopped) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void publishOnce(sql, storeAddress);
    }, debounceMs);
  }

  return {
    start: (database, storeAddress, block$): void => {
      void publishOnce(database, storeAddress); // immediate publish on startup
      sub = block$.subscribe({
        next: () => schedule(database, storeAddress),
        error: (err) => log.error("block stream error", { error: err instanceof Error ? err.message : String(err) }),
      });
    },
    stop: (): void => {
      stopped = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      sub?.unsubscribe();
    },
  };
}
