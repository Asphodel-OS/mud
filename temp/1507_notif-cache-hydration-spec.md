# Spec: Hydrate notification projector caches on boot

## Problem

`notificationEventProjector` (and its sibling `tourneyAnnouncementProjector`) decide _who_ to
push-notify using **in-process caches** learned from `Store_SetRecord` logs as blocks stream past:

- `ownerById` / `ownerByIndex` ← `TaruchiCore` writes (mint/reroll)
- `duelPlayersById` ← `Duel` enroll writes
- `bracketById` / `playersById` ← `Tourney` enroll writes
- `lastStateById` ← `TaruchiStatus` writes (mint-reveal gate)

The indexer **resumes from the last indexed block on restart** (`getStartBlock` →
`chainState.blockNumber + 1n`) and the caches start empty (`emptyCaches()`), so every fact taught
by a block before the restart is lost:

1. **Dropped duel/festival pushes** — a taruchi minted before the restart has no
   `ownerByIndex` entry; its duel/festival resolution logs
   `owner not in cache; skipping notification` (observed in prod: `what: "duel", key: 3`,
   block 11278049) and the push is silently dropped.
2. **Dropped results entirely** — a duel/tourney _enrolled_ before the restart isn't in
   `duelPlayersById`/`bracketById`; its result logs `result-unknown-id` and nobody is notified.
3. **False mint pushes** — `lastStateById` is empty after restart, so the first
   `TaruchiStatus` full SetRecord for a pre-restart taruchi that lands IDLE (e.g. returning
   from training/duel, if written as a full SetRecord) looks like a first write → false
   "Your Taruchi is ready" push (or a spurious `mint` warn when the owner is also unknown).
4. **tourneyAnnouncementProjector**: same class of bug — a festival enrolled pre-restart
   finishes post-restart → `tourney result with no known bracket; skipping` → missed
   announcement; every pre-restart duel resolving post-restart warn-spams the same line.

## Insight

All of this state is already durable in Postgres. The MUD storage adapter maintains
`mud.records` — the **current** raw record (`key_bytes`, `static_data`) per
`(address, table_id)` — kept in lockstep with the block cursor the indexer resumes from
(including splice updates, which keep `static_data` current even when we never saw the enroll
SetRecord). The referral-rewards projection already hydrates from it on boot
(`resetReferralRewardStateFromStoreRecords`), establishing the pattern **and** the decode
posture (same byte offsets as the log path).

## Design

### 1. Generic record fetch — `fetchSetRecords` (in `supabasePush.ts`)

```ts
export async function fetchSetRecords(sql: Sql, storeAddress: Hex, tableId: Hex): Promise<SetRecord[]>;
```

- `SELECT key_bytes, static_data FROM <transformSchemaName("mud")>.records
 WHERE address = ${hexToBytes(storeAddress)} AND table_id = ${hexToBytes(tableId)}
 AND is_deleted IS DISTINCT FROM true AND static_data IS NOT NULL`
- Returns `SetRecord[]` (`{ keyTuple: [keyBytesHex], staticData }`) — all watched tables key on a
  single `uint256`, so `key_bytes` **is** `keyTuple[0]` and `keyToId` behaves identically to the
  log path.
- Missing table (first boot, `42P01` / `3F000`) → `[]`, mirroring
  `fetchRawReferralRewardRows`.

Placement: `supabasePush.ts` already owns `SetRecord`, `setRecordsFor`, `keyToId`,
`readStaticUint` — this is the same tier of shared projector infrastructure.

### 2. Shared learn helpers (refactor inside `notificationEventProjector.ts`)

Extract the three learn loops from `extractNotifEvents` step 1 into private helpers so the
log path and the hydration path decode with the **same code** (offsets can't drift):

```ts
function learnCore(rec: SetRecord, caches: NotifCaches): void; // ownerById + ownerByIndex
function learnDuelEnroll(rec: SetRecord, caches: NotifCaches): void; // duelPlayersById
function learnTourneyEnroll(rec: SetRecord, caches: NotifCaches): void; // bracketById + playersById
```

`extractNotifEvents` behavior is unchanged (pure refactor; existing tests must stay green).

### 3. Pure hydration — `hydrateNotifCaches`

```ts
export type HydrationRecords = {
  core: SetRecord[];
  status: SetRecord[];
  duels: SetRecord[];
  tourneys: SetRecord[];
};
export function hydrateNotifCaches(records: HydrationRecords): NotifCaches;
```

- Runs the learn helpers over core/duels/tourneys.
- Seeds `lastStateById` from status records (**marks ids as seen; never emits events**) —
  closes the false-mint hole (#3).
- Leaves `lastBlock` at `-1` (first live block establishes it; reorg-gate semantics unchanged).
- Pure and unit-testable, mirroring `extractNotifEvents`.

### 4. DB entry point — `hydrateNotifCachesFromDb`

```ts
export async function hydrateNotifCachesFromDb(sql: Sql, storeAddress: Hex): Promise<NotifCaches>;
```

Four `fetchSetRecords` calls **inside one read-only transaction** (`sql.begin`) so the four
tables are read from a single snapshot → `hydrateNotifCaches`. Logs a summary
(`owners`, `duels`, `tourneys`, `statuses`, `skipped` counts) so the fix is observable at boot.

**Malformed-row guard** (codex finding #4): raw storage can create rows via
`Store_SpliceStaticData` on a previously-absent record (prev `"0x"`), so `static_data` can be
shorter than the offsets we read; `sliceHex` would throw and fail-open the _whole_ hydration.
`hydrateNotifCaches` therefore checks a per-table minimum static length (core 24, status 2,
duel 8, tourney 57) and skips + counts short rows instead of throwing.

### 5. Factory params

- `createNotificationEventProjector(initialCaches: NotifCaches = emptyCaches())`
- `createTourneyAnnouncementProjector(seed?: { bracketById?: Map<string, number>; knownDuelIds?: Set<string> })`

### 6. Wiring (`postgres-decoded-indexer.ts`) — per sync attempt, NOT top-level

**(Revised per codex finding #1.)** The reorg-safe adapter **rolls `mud.records` back to the
common ancestor before throwing `ReorgError`** (`rollbackToBlock` in
`createReorgSafeStorageAdapter.ts:45`), and `run()` then re-enters `startSync()`. Top-level
projectors would carry orphaned-branch cache entries across that rollback. So hydration,
projector creation, **and `createSupabasePushAdapter`** all move _inside_ `startSync()`, at the
top of each attempt:

```ts
const notifCaches = env.PUBLISH_RESULTS_TO_SUPABASE && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.STORE_ADDRESS
  ? await hydrateNotifCachesFromDb(sql, env.STORE_ADDRESS).catch((e) => { log error; return emptyCaches(); })
  : emptyCaches();
const supabasePush = createSupabasePushAdapter({ ..., projectors: [
  createTourneyAnnouncementProjector({
    bracketById: new Map(notifCaches.bracketById),
    knownDuelIds: new Set(notifCaches.duelPlayersById.keys()),
  }),
  createNotificationEventProjector(notifCaches),
]});
```

- Every attempt (first boot, reorg restart) starts with caches equal to the exact DB state at
  the resume cursor — no orphaned-branch ghosts, no stale reveals. The in-extract reorg gate
  (`lastBlock` regression → clear `lastStateById`) stays as belt-and-suspenders.
- Recreating the supabase client per attempt is fine: HTTP-only PostgREST client, realtime
  transport stubbed, no persistent connections. Reorgs are rare; the extra hydration query per
  reorg restart is negligible.
- **Fail-open**: a hydration error degrades to today's behavior (empty caches), never blocks boot.
- Tourney projector seeded from the same result (no second query) with **independent copies**,
  since the tourney projector consumes (`delete`s) its duel ids.
- Skipped when push is disabled (projectors never run) or `STORE_ADDRESS` unset
  (can't scope `mud.records`; behavior = today's).

### 7. Single-writer invariant (codex finding #2)

`mud.records` and the `mud.config` cursor commit atomically per block, so
"hydrated state ≤ resume cursor" holds **for a single writer**. This indexer is the DB's only
writer (the reorg loop is in-process, not a second instance). Document this in the hydration
function's comment; the one-transaction fetch in §4 removes intra-hydration skew. If
multi-writer ever becomes real, hydration + cursor read must share one snapshot — out of scope
here.

## Edge cases considered

- **First boot / missing `mud.records`** → `fetchSetRecords` returns `[]` → empty caches;
  backfill from `START_BLOCK` teaches everything, as today.
- **Consistency window**: `mud.records` reflects state ≤ resumed cursor; sync resumes at
  cursor+1. No gap, no overlap.
- **Reorg replay after boot**: `ReorgError` restarts `startSync`, which now recreates and
  rehydrates the projectors from the rolled-back `mud.records` — caches match the common
  ancestor exactly. Hydration doesn't touch `lastBlock`, so the in-extract reorg gate is
  unchanged (now belt-and-suspenders).
- **Records spliced after enroll**: `mud.records.static_data` is the _current_ blob; the fields
  we read (owner, player indices, bracket, packed players) are set at enroll/mint and stable.
- **Resolved duels in the seed**: hydration can't distinguish in-flight from resolved duels
  without decoding `Duel.status` (deliberately avoided, same posture as the log path). Dead
  entries are bounded by total-duels-ever — the same never-pruned posture `duelPlayersById`
  already has. Update the `knownDuelIds` comment accordingly.
- **Deleted records (codex finding #3)**: the live log path ignores `Store_DeleteRecord`
  (cache entries are never removed); hydration filters `is_deleted`. So a deleted-then-resolved
  row behaves differently with vs without a restart in between (dead push vs skip). Accepted:
  notifications are best-effort one-shots, none of the watched flows delete rows in their
  normal lifecycle, and the post-restart behavior (skip) is the safer of the two. Noted in the
  hydration comment; no delete handling added to the live path.
- **Push disabled**: zero new queries, zero behavior change.

## Non-goals

- No DB fallback reads on cache miss during live processing (hot path stays read-free;
  the `warnMiss` logs remain as a genuine-anomaly signal).
- No pruning strategy changes.
- No backfill/redelivery of pushes already missed.

## TDD plan (RED → GREEN per case)

In `notificationEventProjector.test.ts` (pure, no DB):

1. **The prod bug**: hydrate with core(A@10, B@20) + duel enroll(999: 10 vs 20); feed only
   `tourneyResultLog(999)` to `extractNotifEvents` → both duel events. (Fails today: no export.)
2. **Festival across restart**: hydrate core + tourney enroll (bracket 5); result → both
   festival events.
3. **No false mint**: hydrate status(id 1, IDLE); a later `statusLog(1, IDLE)` →
   no mint event.
4. **Hydration emits nothing**: `hydrateNotifCaches` returns caches only (type-level) and
   seeded caches don't fire without a result log.
5. **result-unknown-id resolved**: duel enrolled only via hydration (not logs) no longer
   warns unknown — covered by (1).

In `tourneyAnnouncementProjector.test.ts`:

6. Seeded `knownDuelIds` → duel result produces no announcement and no bracket warn
   (via `extractFinishedFestivals` with pre-seeded maps — already parameterized).
7. Seeded `bracketById` (festival) → result post-restart emits the announcement.
8. **Short static_data rows are skipped, not thrown**: `hydrateNotifCaches` with a core/tourney
   record whose `staticData` is shorter than the required offsets returns caches built from the
   valid rows and reports the skip count.

`fetchSetRecords` / `hydrateNotifCachesFromDb` / bin wiring: thin SQL + plumbing, not
unit-tested (matches the repo posture for `fetchRawReferralRewardRows`); verified by
typecheck + lint + existing suite green.

## Acceptance criteria

- All new tests fail before implementation and pass after; entire package suite green.
- `pnpm lint` and `pnpm build` (typecheck) pass in `packages/store-indexer`.
- After a restart with existing data, a pre-restart taruchi's duel resolution produces a
  push row instead of `owner not in cache; skipping notification`.
- Boot log line reports hydrated cache sizes (and skipped malformed rows).

---

Validated by codex (`omc ask codex`, 2026-07-15): core design approved; four findings
(reorg-rollback rehydration, single-writer snapshot, delete divergence, short static_data
guard) folded into §4, §6, §7 and the edge cases above.

_Edited: 2026-07-15_
