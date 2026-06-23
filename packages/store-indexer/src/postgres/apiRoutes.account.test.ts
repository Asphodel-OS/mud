import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_AGGREGATE } from "../leaderboard/types";
import { apiRoutes } from "./apiRoutes";
import type { LeaderboardCache } from "./aggregateCache";

vi.mock("@latticexyz/store-sync", (): { schemasTable: { tableId: string } } => ({
  schemasTable: { tableId: "0x00" },
}));
vi.mock("@latticexyz/store-sync/indexer-client", (): { input: { parse: (value: unknown) => unknown } } => ({
  input: { parse: (value: unknown): unknown => value },
}));
vi.mock("@latticexyz/store-sync/postgres", (): { transformSchemaName: (name: string) => string } => ({
  transformSchemaName: (name: string): string => name,
}));
vi.mock("./queryLogs", (): { queryLogs: () => { execute: () => Promise<unknown[]> } } => ({
  queryLogs: (): { execute: () => Promise<unknown[]> } => ({ execute: async (): Promise<unknown[]> => [] }),
}));
vi.mock("./recordToLog", (): { recordToLog: (record: unknown) => unknown } => ({
  recordToLog: (record: unknown): unknown => record,
}));

const WALLET = "0x00000000000000000000000000000000000000aa";
const REFERRER = "0x000000000000000000000000000000000000beef";

function cache(overrides: Partial<LeaderboardCache> = {}): LeaderboardCache {
  return {
    isReady: () => true,
    getAggregate: () => EMPTY_AGGREGATE,
    getStats: () => null,
    getRoster: () => [],
    getBattles: () => [],
    getTaruchi: () => null,
    getAccount: () => ({ index: 7, referrer: REFERRER, createdBlock: "12345" }),
    getReferralCount: () => 4,
    computedAt: () => 111,
    indexedBlock: () => 222n,
    rebuildNow: async (): Promise<void> => {},
    start: (): void => {},
    stop: (): void => {},
    ...overrides,
  };
}

async function getJson(
  path: string,
  leaderboardCache: LeaderboardCache = cache(),
): Promise<{ status: number; body: unknown }> {
  const headers = new Map<string, string>();
  const ctx = {
    method: "GET",
    path,
    url: path,
    originalUrl: path,
    query: {},
    req: { headers: {} },
    request: { ip: "" },
    ip: "",
    status: 404,
    body: undefined as unknown,
    set: (name: string, value: string): void => {
      headers.set(name, value);
    },
    vary: (): void => {},
    get: (): string => "",
  };

  await apiRoutes({} as Sql, leaderboardCache)(ctx as never, async (): Promise<void> => {});

  return {
    status: ctx.status,
    body: typeof ctx.body === "string" ? JSON.parse(ctx.body) : ctx.body,
  };
}

describe("apiRoutes account payloads", () => {
  it("serves a lightweight account endpoint", async () => {
    const res = await getJson(`/api/account/${WALLET.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      wallet: WALLET,
      account: { index: 7, referrer: REFERRER, createdBlock: "12345" },
      referralCount: 4,
      computedAt: 111,
    });
  });

  it("includes account data on trainer payloads", async () => {
    const res = await getJson(`/api/trainer/${WALLET.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      wallet: WALLET,
      stats: null,
      roster: [],
      account: { index: 7, referrer: REFERRER, createdBlock: "12345" },
      referralCount: 4,
      computedAt: 111,
    });
  });

  it("returns 503 while the aggregate cache is warming", async () => {
    const res = await getJson(`/api/account/${WALLET}`, cache({ isReady: (): boolean => false }));

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "leaderboard cache warming up" });
  });
});
