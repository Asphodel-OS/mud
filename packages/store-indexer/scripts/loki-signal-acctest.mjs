#!/usr/bin/env node
// Signal-delivery acceptance gate (plan Phase 3.5).
//
// Proves the thing unit tests structurally cannot: that a REAL SIGTERM reaches
// the Node process under the exec-direct command and triggers the graceful Loki
// flush + clean exit. The unit suite calls close() in-process; only this gate
// exercises the OS signal path.
//
// Two arms, both run the exec-direct command `node --import tsx src/bin/<entry>`:
//  - FRONTEND: registers its handler synchronously after server.listen(); a live
//    /api/logs-live SSE connection is opened first so the bounded httpServer.close()
//    path is exercised, not bypassed.
//  - INDEXER: registers its handler BEFORE the top-level await of the RPC connect.
//    RPC points at a black-hole server (accepts, never responds) so the process is
//    parked mid-connect when SIGTERM lands — proving the handler attaches at import
//    time, not after the connect resolves.
//
// CONTAINER form (CI gate against the built image), same shape:
//   docker run -d --network host -e GRAFANA_LOKI_URL=http://127.0.0.1:<port>/loki/api/v1/push \
//     -e LOG_SERVICE=indexer-api -e DATABASE_URL=... -e STORE_ADDRESS=0x... \
//     <image> node --import tsx src/bin/postgres-frontend.ts
//   docker kill --signal=TERM <cid>   # SIGTERM to PID 1 (node, via init: true)
//   docker wait <cid>                 # must print 0

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const received = [];
const loki = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push(raw);
    res.statusCode = 204;
    res.end("ok");
  });
});
await new Promise((r) => loki.listen(0, "127.0.0.1", r));
const lokiUrl = `http://127.0.0.1:${loki.address().port}/loki/api/v1/push`;

// Black-hole RPC: accepts the connection, never responds, so getChainId parks.
const blackholeSockets = new Set();
const blackhole = createServer(() => {});
blackhole.on("connection", (s) => {
  blackholeSockets.add(s);
  s.on("close", () => blackholeSockets.delete(s));
});
await new Promise((r) => blackhole.listen(0, "127.0.0.1", r));
const blackholeUrl = `http://127.0.0.1:${blackhole.address().port}`;

const baseEnv = {
  ...process.env,
  GRAFANA_LOKI_URL: lokiUrl,
  GRAFANA_LOKI_USER: "u",
  GRAFANA_LOKI_API_KEY: "k",
  GRAFANA_LOKI_ENV: "acctest",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://127.0.0.1:1/none",
  STORE_ADDRESS: "0x0000000000000000000000000000000000000001",
  START_BLOCK: "0",
  POLLING_INTERVAL: "600000",
};

function shutdownServers() {
  for (const s of blackholeSockets) s.destroy();
  blackhole.close();
  loki.close();
}

function abort(child, msg) {
  console.error(`FAIL: ${msg}`);
  try {
    child?.kill("SIGKILL");
  } catch {}
  shutdownServers();
  process.exit(1);
}

async function runArm({ label, entry, env, needle, openSse }) {
  const before = received.length;
  const child = spawn("node", ["--import", "tsx", `src/bin/${entry}`], {
    cwd: pkgDir,
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", () => {});
  let earlyExit = null;
  child.on("exit", (code) => (earlyExit = code));

  const bootStart = Date.now();
  while (!stdout.includes(needle) && earlyExit === null && Date.now() - bootStart < 20000) {
    await delay(150);
  }
  if (earlyExit !== null) abort(child, `[${label}] exited early (code ${earlyExit}) before SIGTERM`);
  if (!stdout.includes(needle)) abort(child, `[${label}] did not boot / emit startup log via exec-direct command`);
  console.log(`[${label}] boot OK: exec-direct command started node and emitted the startup log`);

  let sseController;
  if (openSse) {
    sseController = new AbortController();
    fetch(`http://127.0.0.1:${env.PORT}/api/logs-live?input=${encodeURIComponent('{"filters":[]}')}&block_num=0`, {
      signal: sseController.signal,
    }).catch(() => {});
    await delay(300);
  } else {
    // Give the indexer a moment to reach its parked top-level await.
    await delay(400);
  }

  const killAt = Date.now();
  child.kill("SIGTERM");
  const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const elapsed = Date.now() - killAt;
  sseController?.abort();

  if (exitCode !== 0) abort(child, `[${label}] expected exit 0 on SIGTERM, got ${exitCode}`);
  if (elapsed > 5000) abort(child, `[${label}] shutdown took ${elapsed}ms (> bounded grace)`);
  if (!received.slice(before).join("").includes(needle)) {
    abort(child, `[${label}] fake Loki never received the startup batch — SIGTERM->flush did not run`);
  }
  console.log(`[${label}] PASS: SIGTERM -> exit 0 in ${elapsed}ms; Loki received the final batch`);
}

await runArm({
  label: "frontend",
  entry: "postgres-frontend.ts",
  env: { LOG_SERVICE: "indexer-api", HOST: "127.0.0.1", PORT: "37337" },
  needle: "starting postgres-frontend",
  openSse: true,
});

await runArm({
  label: "indexer",
  entry: "postgres-decoded-indexer.ts",
  env: { LOG_SERVICE: "indexer-store", RPC_HTTP_URL: blackholeUrl },
  needle: "starting postgres-decoded-indexer",
  openSse: false,
});

console.log("ALL ARMS PASS");
shutdownServers();
process.exit(0);
