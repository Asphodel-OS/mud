# leaderboard/ — server-side aggregation closure

This is a **copy** of the pure leaderboard-aggregation logic from the game2 client
(`game2/packages/client/src/`), ported here so the Prologue indexer's
`postgres-frontend` can compute the leaderboard / roster / battles indexes once
on the server (cached, 60 s) instead of every client downloading ~34k+ rows and
aggregating locally.

**game2 is the source of truth.** This copy exists because a shared package
across the two separate-origin repos is too much machinery for the playtest.
Drift is guarded by `buildAggregate.test.ts` (self-contained golden cases ported
from game2's `buildAggregate.test.ts` — it builds its own fixtures via `packU32`
and does NOT import from the sibling game2 checkout, which CI won't have).

If you change aggregation behavior, change it in game2 first, then mirror here and
re-run the parity test. Files mirror their game2 origins:

| here                     | game2 origin                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `packUtils.ts`           | `src/lib/packUtils.ts`                                        |
| `onyxConstants.ts`       | `src/common/onyxConstants.ts`                                 |
| `tourneyMath.ts`         | `src/lib/tourneyMath.ts`                                      |
| `sort.ts`                | `src/mud/useLeaderboard/sort.ts`                              |
| `types.ts`               | `src/mud/useLeaderboard/types.ts`                             |
| `affinities.ts`          | extract of `src/types/taruchi.ts` (`Affinity` + `AFFINITIES`) |
| `buildAggregate.ts`      | `src/mud/useLeaderboard/buildAggregate.ts`                    |
| `buildAggregate.test.ts` | `src/mud/useLeaderboard/buildAggregate.test.ts`               |

Only import paths were rewritten (flattened into this dir); logic is byte-identical.
(The test additionally got explicit return-type annotations on three stub helpers
to satisfy mud's stricter eslint — `@typescript-eslint/explicit-function-return-type` —
no behavioral change.)
The only external runtime dep is `viem` (already a store-indexer dependency).
`spriteFor` / `decodeName` are injected by the caller (the cache builder), not imported.
