type LokiEntry = { ts: number; level: string; line: string };

type LokiConfig = {
  url: string;
  user: string;
  apiKey: string;
  labels: { service: string; env: string };
  batchSize: number;
  batchIntervalMs: number;
  timeoutMs: number;
  queueSize: number;
};

type LokiTransport = {
  enqueue(entry: LokiEntry): void;
  close(timeoutMs: number): Promise<void>;
};

type LokiStream = { stream: Record<string, string>; values: [string, string][] };

function buildStreams(labels: LokiConfig["labels"], entries: readonly LokiEntry[]): LokiStream[] {
  const byLevel = new Map<string, [string, string][]>();
  for (const entry of entries) {
    const tsNanos = `${entry.ts}000000`;
    let values = byLevel.get(entry.level);
    if (!values) {
      values = [];
      byLevel.set(entry.level, values);
    }
    values.push([tsNanos, entry.line]);
  }
  return Array.from(byLevel, ([level, values]) => ({ stream: { ...labels, level }, values }));
}

export function createLokiTransport(cfg: LokiConfig): LokiTransport {
  const queue: LokiEntry[] = [];
  // Serialize sends so close() can await the whole chain via the last promise,
  // and so a slow Loki can't interleave half-written batches.
  let inFlight: Promise<void> = Promise.resolve();

  const authHeader =
    cfg.user && cfg.apiKey ? `Basic ${Buffer.from(`${cfg.user}:${cfg.apiKey}`).toString("base64")}` : undefined;

  async function send(batch: readonly LokiEntry[]): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) headers.Authorization = authHeader;
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ streams: buildStreams(cfg.labels, batch) }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (res.status >= 300) {
        process.stderr.write(`loki push: status ${res.status}\n`);
      }
    } catch (err) {
      // Push failures drop the batch (stdout already has every line); never
      // surface to the caller — logging must not add latency or throw.
      process.stderr.write(`loki push: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  function flush(): void {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    inFlight = inFlight.then(() => send(batch));
  }

  const interval = setInterval(flush, cfg.batchIntervalMs);
  interval.unref();

  return {
    enqueue(entry: LokiEntry): void {
      // Drop on overflow: stdout already carries the entry, so trading the Loki
      // copy for zero caller latency (mirrors keryx's non-blocking select).
      if (queue.length >= cfg.queueSize) return;
      queue.push(entry);
      if (queue.length >= cfg.batchSize) flush();
    },
    async close(timeoutMs: number): Promise<void> {
      clearInterval(interval);
      flush();
      const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      await Promise.race([inFlight, deadline]);
    },
  };
}

export type { LokiEntry, LokiConfig, LokiTransport };
