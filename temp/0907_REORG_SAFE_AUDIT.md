# REORG_SAFE audit — multi-agent gap analysis of the reorg-protection design

**Verdict: do NOT enable `REORG_SAFE=true` as-is.** The mechanism misses most realistic
mainnet reorgs, and when it does fire, the rollback itself can corrupt state or wedge the
process. Five independent audit lenses converged on the same core defects.

Method: 5 parallel auditors (detection-coverage, rollback-correctness, crash-atomicity,
ancestor-window, integration-sideeffects) over the full reorg machinery, followed by one
adversarial verifier per finding whose default position was "refute it". 51 raw findings →
48 confirmed, 2 refuted (55 agents). Related incident context: [0907_INDEXER_SKIPPED_BLOCK.md](./0907_INDEXER_SKIPPED_BLOCK.md).

Files audited:
`store-indexer/src/postgres/{createReorgSafeStorageAdapter,reorgHandler,rewindLog,blockCache,reorgTables,ReorgError}.ts`,
`store-indexer/src/bin/postgres-decoded-indexer.ts`,
`store-sync/src/{createStoreSync,fetchAndStoreLogs}.ts`,
`store-sync/src/postgres{,-decoded}/createStorageAdapter.ts`,
`block-logs-stream/src/*`.

---

## Critical defects

### A. Detection is blind to most real reorgs

`createReorgSafeStorageAdapter.ts:35-38` — detection requires the **current** block to have
World logs (`blockHash` is taken from `logs[0]`) AND a stored hash for block N−1.

Failure sequence on a sparse world (the common case):

1. Orphaned block N with World logs is indexed; hash A_N stored.
2. 1-block reorg replaces N. Canonical N+1 has no World logs → it reaches the adapter as
   `{blockNumber: N+1, logs: []}` (the `groupLogsByBlockNumber` range-final entry), so
   `blockHash` is `undefined` → **detection gate skipped entirely**.
3. The `latestBlock$` tap (`postgres-decoded-indexer.ts:173-187`) stores the **canonical**
   hash for N+1 into the same `block_cache`.
4. Canonical logged block N+2 arrives: its `parentHash` matches the tap-stored canonical
   hash(N+1) → **passes**. The stale fork hash at height N is never re-examined (only
   blockNumber−1 is ever compared).

Consequence: orphaned writes persist forever AND canonical block N's logs are **never
fetched** (`createStoreSync.ts:305-307` advances `fromBlock` past it). Corruption in both
directions, zero errors logged. With `RPC_WS_URL` set it's worse: `newHeads` re-emits the
same-height replacement block and the tap **overwrites the orphaned hash with the canonical
one — destroying the only evidence** before any comparison.

Fix: store a hash for **every** adapter-processed block (fetch header when logs are empty),
and verify continuity against the most recent _stored_ hash, not just blockNumber−1.

### B. Rollback restores the wrong snapshot on multi-block reorgs

`rewindLog.ts:79, 89-92` — `restoreFromRewindLog` orders entries `desc(blockNumber)` with
first-wins dedupe. For a key written in ≥2 orphaned blocks, the NEWEST pre-image wins —
an **intermediate orphaned-fork value**, not the common-ancestor value (which lives in the
oldest entry). The rollback then deletes the rewind entries, destroying the correct
snapshot. Hot game keys written near-every-block make key overlap across orphaned blocks
near-certain.

Fix (one-liner): order ascending, keep first-wins — oldest pre-image = ancestor value.

### C. Decoded rows are deleted, never restored

`reorgHandler.ts:91-92` — `deleteStaleDecodedRows` DELETEs every decoded row with
`__last_updated_block_number > ancestor`, including rows merely _updated_ by an orphaned
block. The raw `mud.records` row gets restored from the rewind log, but **nothing
re-materializes the decoded row**. Unless canonical resync happens to re-touch that exact
record, the decoded row is permanently missing → permanent raw/decoded divergence.

Fix: after restoring raw records, re-decode the affected keys from `mud.records` into the
decoded tables (mirroring what `rollbackReferralRewardProjection` already does for its own
projection).

### D. `rollbackToBlock` is not atomic; config is rewound LAST

`reorgHandler.ts:57-70` — five separate statements, no transaction: restore records →
delete stale decoded rows → referral rollback → delete rewind-log entries → delete
block-cache entries → **then** rewind `mud.config`. A crash after the evidence deletes but
before the config update = evidence destroyed, cursor still ahead → permanently
unrecoverable. Readers (the frontend serves continuously) also observe half-rolled-back
state mid-sequence.

Fix: wrap the whole rollback in one transaction — or rewind config FIRST, which makes every
crash window recoverable by resync-from-ancestor.

### E. `findCommonAncestor` treats a missing hash as proof of canonicality

`reorgHandler.ts:36-45` — the walk returns the first block with **no stored hash** as the
ancestor without verifying it against the chain. Hashes only exist for logged/polled blocks
and are pruned below `blockNumber − reorgWindow`, so gaps are routine — the walk can stop
**inside the orphaned fork** and roll back to a wrong-fork target.

Fix: treat "no stored hash" as _unknown_, never as _canonical_ — keep walking to the nearest
stored hash and only terminate on a verified canonical match; throw if the window exhausts.

## High

| Defect                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                        | Note                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **F.** `block_cache` has two unsynchronized writers — the fire-and-forget `latestBlock$` tap races the adapter; last-writer-wins; detection outcome is timing-dependent                                                                                                                                                                                                                                                            | `postgres-decoded-indexer.ts:176`                            | Single-writer the cache (adapter only)                                                                         |
| **G.** `ReorgError` never reaches the `run()` restart loop — it errors handler-less RxJS subscriptions (`storedBlockLogs$.subscribe()` at `:189`), which rethrow asynchronously → **process crash** instead of in-process restart. Recovery happens only because ECS restarts the container (rollback committed before the throw). Restart also leaks the old poller/SQS client and leaves `/api/logs-live` bound to a dead stream | `postgres-decoded-indexer.ts:189`                            | Add error handlers to every subscription, or route consumption through `startSync`'s single promise            |
| **H.** Detection's own `getBlock` calls trust a possibly-lagging RPC (same class as the skipped-block incident) and never check `blockHeader.hash === logs[0].blockHash` for the block being applied                                                                                                                                                                                                                               | `createReorgSafeStorageAdapter.ts:39-40`                     |                                                                                                                |
| **I.** No boot-time reorg check — a reorg during downtime/deploy is permanently undetectable (`getStartBlock` resumes blindly at cursor+1)                                                                                                                                                                                                                                                                                         | `postgres-decoded-indexer.ts:114`                            | Verify highest stored hashes vs chain on boot before syncing                                                   |
| **J.** (broader than reorg) The decoded adapter commits raw+`mud.config` and decoded rows in **two separate transactions** — a crash between them desyncs decoded permanently, since resume starts at config+1                                                                                                                                                                                                                     | `store-sync/src/postgres-decoded/createStorageAdapter.ts:36` | Advance the cursor with/after the decoded commit, or resume at config (not +1) with idempotent decoded upserts |

## Medium / Low

- Deep-reorg (>`REORG_WINDOW`=64) throws BEFORE any rollback and is not a `ReorgError` →
  hard crashloop while serving orphaned data; no documented recovery (`reorgHandler.ts:47`).
- `storeBlockHash` commits separately after the block's data write → crash gaps in
  `block_cache` that both skip detection and mislead the ancestor walk.
- Orphaned-block side effects (SQS reveals, Supabase announcements/notifications) are never
  compensated, and their canonical replacements are then suppressed by the `isCaughtUp`
  reset during resync.
- Rewind snapshots don't capture `log_index` → restored rows differ from a from-scratch
  index.
- `getStartBlock` swallows ALL DB errors and silently falls back to `START_BLOCK` → an
  outage-time DB blip triggers a full replay through un-gated side-effect adapters. Only
  42P01/3F000 should be swallowed.
- **Zero automated tests** for the entire reorg/rewind machinery.

## Refuted (for the record)

- "Crash between adapter write and `storeBlockHash` removes the predecessor hash detection
  needs" — refuted: the head-stream tap also writes the hash, so the window is narrower
  than claimed.
- "Referral rollback commits an empty claimable table on early-return" — the code path
  exists but the triggering precondition (no decoded schema present) cannot co-occur with
  live referral state.

---

## Recommendation

1. **Do not enable `REORG_SAFE` as-is** — it adds crashloops and wrong-fork rollbacks
   without reliably adding protection.
2. **Prefer confirmation lag**: index block N only once N+k exists (k=2 ≈ 24s latency).
   Post-merge mainnet reorgs are essentially always 1 block deep; a 2-block lag eliminates
   the entire class with ~30 lines and no rollback machinery. Pair with the replay-window
   resume for missed-write self-healing.
3. If real-time `latest` indexing is non-negotiable, the minimum repair set before enabling:
   A (hash every block + walk-back verify), B (asc ordering — one-liner), C (re-decode after
   restore), D (transactional rollback), E (unknown ≠ canonical), G (error routing) — plus
   tests for all of it.

---

_Created: 2026-07-09. Source: workflow `reorg-safe-gap-audit` (55 agents; full findings in
the session workflow output)._
