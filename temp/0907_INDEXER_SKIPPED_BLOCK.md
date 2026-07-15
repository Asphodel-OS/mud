# Incident: MUD indexer silently skipped block 25485734 — taruchi stuck "BATTLE IN PROGRESS"

## Summary

On 2026-07-08 ~05:23:51 UTC the prod MUD store-indexer **silently skipped mainnet block
25485734**, which contained the 7 Store events of a duel resolution (keryx match 317, duel
`24261076…294682`). The on-chain resolve succeeded, but the indexer's projection never saw it,
leaving both duel participants frozen at `TaruchiStatus.state = 2 (ENROLLED)`:

- taruchi **163 "Placorion"** (`…007049`, owner `0x852580cda8e320ffbca989be37eef9b99b8fbc91`)
- taruchi **170** (`…007047`-adjacent id, opponent, owner `0x3083bf…`)

The client (`prolog/packages/client/src/AppShell.tsx`) auto-redirects to Arena whenever a
taruchi's indexed state is ENROLLED, so the affected user saw a permanent "BATTLE IN PROGRESS".
Client **Reset State** only clears `localStorage` — it re-hydrates the same stale indexed state
on every login, so it cannot fix this.

## Evidence chain

| Surface               | Query                                                                                   | Result                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Chain (ground truth)  | `cast call $WORLD "getField(...)" $TARUCHI_STATUS "[$ID163]" 1`                         | `0x01` **IDLE** — resolve applied on-chain                                                      |
| Chain                 | resolve tx `0x7bdbc96ceaa0f94ebab835e368e3dc8294903ee6d95895e3040cd17340abc918` receipt | block **25485734**, `status: success`, **7 World Store events**                                 |
| keryx                 | `GET /matches/{signer}` (admin bypass) + CloudWatch `keryx-prod-cw-matchmaker`          | all 6 matches `resolved`; enroll + resolve mined success; no failures                           |
| Indexer raw layer     | `SELECT … FROM mud.records WHERE block_number = 25485734`                               | **0 rows** — block never ingested                                                               |
| Indexer decoded layer | `app__taruchi_status` for `…007049`                                                     | `state=2`, `__last_updated_block_number=25485730` (the enroll block)                            |
| Indexer cursor        | `mud.config.block_number`                                                               | 25490816+ — far past the skipped block, still advancing                                         |
| Indexer sync log      | CloudWatch `taru-prod-cw-mud-indexer-indexer`                                           | `block processed 25485730` → `25485732` → **`25485736`** (25485734 absent; no warn/error/reorg) |

Frozen rows (prolog DB, schema `0x59ec606dfae238544ef6349d2036443806dad044`):

- `app__taruchi_status` — both participants `state=2` at block 25485730
- `app__taruchi_tourney` — both still linked to duel `24261076…294682` (should be deleted on resolve)
- `app__duel` `24261076…294682` — `status=1` (active), never completed

No reorg occurred (no `reorg detected` / rollback / restart log lines; `REORG_SAFE` is not
enabled in prod anyway).

## Root cause

Two compounding defects in the ingestion path:

### 1. Unvalidated `eth_getLogs` at chain head (the trigger)

Prod runs `FOLLOW_BLOCK_TAG=latest` with `POLLING_INTERVAL=1000`: every ~1s the indexer learns a
new head and immediately fetches `eth_getLogs(lastProcessed+1 → head)`.

`packages/block-logs-stream/src/getLogs.ts:36`:

```ts
if (!opts.internal_clientOptions?.validateBlockRange) {
  const logs = await getRpcClient(opts).request(logsRequest); // bare eth_getLogs
  return logs.map((log) => formatLog(log));
}
```

Without `validateBlockRange` there is **no check that the serving node has indexed up to
`toBlock`**. `eth_getLogs` does not error for a range beyond a node's indexed height — it
silently returns whatever it has. On Alchemy's load-balanced fleet, the head announcement and
the `getLogs` call can be served by different backends; a just-sealed block's logs can be
missing from the response with a `200 OK`.

The transport makes the race wider: `getClientOptions.ts` (non-validate branch) builds
`fallback([webSocket(RPC_WS_URL), http(RPC_HTTP_URL)])` across **two different Alchemy apps**
(WS `rYgmM2_…`, HTTP `ikqJXMjR…`), so head-follow and log-fetch can hit entirely different
clusters.

When the incomplete response came back, `fetchAndStoreLogs` →
`groupLogsByBlockNumber(logs, toBlock)` still emitted the range's final block, so
`lastBlockNumberProcessed` and the durable cursor `mud.config.block_number` advanced past 25485734. No error, no retry, no log line.

This is exactly the failure mode upstream MUD added the `validateBlockRange` flag for
(latticexyz/mud #3394, #3531, #3535 — **all present in this fork, just never enabled in prod**).
The prod task definition (`taru-prod-td-mud-indexer`) sets neither `INTERNAL__VALIDATE_BLOCK_RANGE`
nor `REORG_SAFE`.

### 2. No self-healing resume (why the damage is permanent)

`packages/store-indexer/src/bin/postgres-decoded-indexer.ts` (`getStartBlock`) resumes from
`config.blockNumber + 1`. A skipped block is _behind_ the cursor, so no restart ever revisits
it. One missed range = permanent projection corruption until a manual rewind.

## Fix

### A. Repair prod (one-time runbook)

Store-event replay is idempotent: `Store_SetRecord`/`Store_DeleteRecord` overwrite;
`Store_Splice*` writes the same bytes at the same offsets in the same order. Replaying
25485730 → head converges every row to its correct value and applies the missing block.

Side-effect adapters under replay (verified):

| Adapter                              | Behavior                                                                     | Safe?                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------- |
| Referral projection                  | `PRIMARY KEY (block_number, log_index, referrer)` + `ON CONFLICT DO NOTHING` | ✅                                        |
| Supabase announcements/notifications | gated on `isCaughtUp` (false during replay)                                  | ✅                                        |
| SQS reveal hook                      | not gated — re-pushes reveal trait codes in the window                       | ⚠️ benign (image gen re-renders same PNG) |

Runbook — order matters (the running task writes `mud.config` after every block and would
clobber the rewind):

```bash
# 1. Stop the indexer
aws ecs update-service --region ap-southeast-1 \
  --cluster taru-prod-ecs-mud-indexer --service taru-prod-svc-mud-indexer \
  --desired-count 0

# 2. Rewind the cursor — on the WRITABLE PRIMARY (not api-ro-db)
psql "$PRIMARY_PROLOG_URL" -c "UPDATE mud.config SET block_number = 25485729;"

# 3. Restart — replays ~5k blocks in a minute or two
aws ecs update-service --region ap-southeast-1 \
  --cluster taru-prod-ecs-mud-indexer --service taru-prod-svc-mud-indexer \
  --desired-count 1

# 4. Verify
curl -s https://api.prod.asphodel.io/api/taruchi/4184433446376852228849774545493142741236758747191969989539479998328848007049 \
  | python3 -c "import json,sys; print('state =', json.load(sys.stdin)['state'])"   # expect 1 (IDLE)
```

During replay `/readyz` reports unready and some rows briefly show intermediate historical
values; this clears when it reaches head ("all caught up" in the logs).

### B. Prevention (code/config changes)

1. **Enable range validation** — add to the taru indexer task definition
   (`iac/api/modules/taru`):

   ```
   INTERNAL__VALIDATE_BLOCK_RANGE=true
   ```

   `RPC_HTTP_URL` is already provided (Secrets Manager). With the flag on, `getLogs` batches
   `eth_getBlockByNumber(toBlock)` + `eth_getLogs` on a single HTTP connection to a single node
   and throws `BlockNotFoundError` when the node lacks `toBlock`, which `fetchLogs` retries
   instead of silently advancing. Note this branch is HTTP-only (drops the WS transport for
   log fetching) — fine for a server-side indexer with 1s polling.

2. **Self-healing resume** — in `postgres-decoded-indexer.ts`, resume from a replay window
   instead of `+1`:

   ```ts
   const REPLAY_WINDOW = 64n;
   if (chainState?.blockNumber != null) {
     return bigIntMax(env.START_BLOCK, chainState.blockNumber - REPLAY_WINDOW);
   }
   ```

   Replay is idempotent (see above), costs seconds, and converts any residual silent skip into
   an automatic repair on the next deploy/restart. This covers the case validation cannot: a
   node serving a block header whose log index still lags.

3. **Enable `REORG_SAFE=true` in prod** — the rollback machinery
   (`createReorgSafeStorageAdapter.ts`, `reorgHandler.ts`) exists and correctly rewinds
   `mud.config` on rollback, but it is not active. Following `latest` on mainnet without it
   leaves the same permanent-corruption class open via reorgs.

4. Optional hardening: point `RPC_WS_URL` and `RPC_HTTP_URL` at the same Alchemy app so
   head-follow and log-fetch share one cluster.

## Blast radius

One duel, two taruchi, one user-visible victim (Placorion's owner). Scanned
`app__taruchi_status` joined with `app__taruchi_tourney`: no other pair remains stuck (the other
ENROLLED pair observed during investigation resolved normally at block 25490799).

## Addendum — repair executed + Codex blast-radius review (2026-07-09)

The rewind was executed on 2026-07-09 ~07:26 UTC (cursor set to 25485700, task restarted).
Replay processed the skipped block at 07:29:03 (`block processed 25485734, events: 7`) and
converged with no errors. Verified after repair: `app__taruchi_status` → `state=1` @ 25485734,
tourney link deleted, duel `…294682` → completed, `/api/taruchi/…7049` → `state: 1`,
zero ENROLLED rows remain in the projection.

A Codex review (`.omc/artifacts/ask/codex-blast-radius-review-…2026-07-09T07-30-40Z.md`)
confirmed the approach with corrections worth keeping:

1. **`Store_SpliceDynamicData` replay is NOT idempotent.** Length-changing dynamic splices
   (array push/pop) shift/duplicate bytes when re-applied onto already-current data. Cursor
   rewinds are only provably safe when the replay window contains no dynamic splices (or later
   `SetRecord`s repair them). **Verified for this repair: zero `Store_SpliceDynamicData`
   events in the replayed window** (`eth_getLogs`, topic
   `0xfe158a7adba34e256807c8a149028d3162918713c3838afc643ce9f96716ebfd`, blocks 25485701→head;
   topic-hash convention cross-validated against the resolve receipt's observed topics).
   Run this preflight check before any future cursor rewind. This caveat also applies to the
   `REPLAY_WINDOW` resume idea in §B.2 — gate it on the same check or on tables staying
   static-only.

2. **Guarded rewind SQL** (prevents typos above head and scoping accidents):

   ```sql
   BEGIN;
   SELECT chain_id, block_number FROM mud.config FOR UPDATE;
   UPDATE mud.config SET block_number = <target>
     WHERE chain_id = 1 AND block_number > <target>;
   SELECT chain_id, block_number FROM mud.config;
   COMMIT;
   ```

3. **Raw and decoded writes are not one transaction** — if decode crashes mid-replay the
   cursor may already be past the failed block; rewind again below it before restarting.

4. Don't "full replay from deploy" on top of existing rows as a ghost-row cleanup — if ghosts
   are ever suspected, truncate + rebuild (or fresh DB + swap) is the only clean path.

5. Ascension attestation signing during replay was a flagged risk; verified safe here:
   `apiRoutes.ts` checks `isIndexerCaughtUp` before AND after signing, and
   `ASCENSION_RECORD_MAX_LAG_BLOCKS` defaults to `0n` (strictest).

---

_Created: 2026-07-09. Last edited: 2026-07-09 (post-repair addendum)._
