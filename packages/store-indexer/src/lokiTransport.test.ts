import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createLokiTransport, type LokiConfig } from "./lokiTransport";

type LokiBody = { streams: { stream: Record<string, string>; values: [string, string][] }[] };
type Recorded = { auth?: string; body: LokiBody };

type FakeLoki = { url: string; requests: Recorded[]; close: () => Promise<void> };

async function startFakeLoki(status = 204): Promise<FakeLoki> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) as LokiBody });
      res.statusCode = status;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/loki/api/v1/push`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cfg(url: string, over: Partial<LokiConfig> = {}): LokiConfig {
  return {
    url,
    user: "u1",
    apiKey: "k1",
    labels: { service: "indexer-store", env: "test" },
    batchSize: 100,
    batchIntervalMs: 50,
    timeoutMs: 1000,
    queueSize: 10000,
    ...over,
  };
}

function countValues(requests: Recorded[]): number {
  return requests.reduce((n, r) => n + r.body.streams.reduce((m, s) => m + s.values.length, 0), 0);
}

describe("createLokiTransport", () => {
  let loki: FakeLoki | undefined;

  afterEach(async () => {
    await loki?.close();
    loki = undefined;
    vi.restoreAllMocks();
  });

  it("batches by level with labels {service,env,level} and basic auth", async () => {
    loki = await startFakeLoki();
    const transport = createLokiTransport(cfg(loki.url));
    transport.enqueue({ ts: 1700000000000, level: "info", line: '{"msg":"a"}' });
    transport.enqueue({ ts: 1700000000001, level: "warn", line: '{"msg":"b"}' });
    await transport.close(1000);

    expect(loki.requests).toHaveLength(1);
    const { auth, body } = loki.requests[0];
    expect(auth).toBe(`Basic ${Buffer.from("u1:k1").toString("base64")}`);

    const byLevel = Object.fromEntries(body.streams.map((s) => [s.stream.level, s]));
    expect(Object.keys(byLevel).sort()).toEqual(["info", "warn"]);
    for (const stream of body.streams) {
      expect(Object.keys(stream.stream).sort()).toEqual(["env", "level", "service"]);
      expect(stream.stream.service).toBe("indexer-store");
      expect(stream.stream.env).toBe("test");
    }
    expect(countValues(loki.requests)).toBe(2);
    expect(byLevel.info.values[0][0]).toBe("1700000000000000000");
  });

  it("omits the auth header when user or apiKey is missing", async () => {
    loki = await startFakeLoki();
    const transport = createLokiTransport(cfg(loki.url, { apiKey: "" }));
    transport.enqueue({ ts: 1, level: "info", line: "x" });
    await transport.close(1000);
    expect(loki.requests[0].auth).toBeUndefined();
  });

  it("drops on overflow and never throws", async () => {
    loki = await startFakeLoki();
    const transport = createLokiTransport(cfg(loki.url, { queueSize: 2, batchSize: 1000 }));
    for (let i = 0; i < 5; i++) {
      expect(() => transport.enqueue({ ts: 1, level: "info", line: `l${i}` })).not.toThrow();
    }
    await transport.close(1000);
    expect(countValues(loki.requests)).toBeLessThanOrEqual(2);
  });

  it("flushes remaining entries on close", async () => {
    loki = await startFakeLoki();
    const transport = createLokiTransport(cfg(loki.url, { batchSize: 1000, batchIntervalMs: 100000 }));
    transport.enqueue({ ts: 1, level: "info", line: "only" });
    await transport.close(1000);
    expect(loki.requests).toHaveLength(1);
    expect(countValues(loki.requests)).toBe(1);
  });

  it("swallows push errors and writes one stderr line", async () => {
    loki = await startFakeLoki(500);
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const transport = createLokiTransport(cfg(loki.url, { batchSize: 1 }));
    transport.enqueue({ ts: 1, level: "error", line: "boom" });
    await transport.close(1000);
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("loki push: status 500");
  });

  it("flushes on the interval timer without hitting batchSize", async () => {
    loki = await startFakeLoki();
    const transport = createLokiTransport(cfg(loki.url, { batchSize: 1000, batchIntervalMs: 30 }));
    transport.enqueue({ ts: 1, level: "info", line: "tick" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loki.requests.length).toBeGreaterThanOrEqual(1);
    await transport.close(1000);
  });
});

describe("logger shipping gate", () => {
  it("ships nothing and leaves stdout intact when GRAFANA_LOKI_URL is unset", async () => {
    const prev = process.env.GRAFANA_LOKI_URL;
    delete process.env.GRAFANA_LOKI_URL;
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const mod = await import("./logger");
    mod.logger.info("hello");
    await mod.flushLogs();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    stdoutSpy.mockRestore();
    fetchSpy.mockRestore();
    if (prev === undefined) {
      delete process.env.GRAFANA_LOKI_URL;
    } else {
      process.env.GRAFANA_LOKI_URL = prev;
    }
    vi.resetModules();
  });
});
