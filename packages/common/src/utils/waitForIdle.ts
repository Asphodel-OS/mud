export function waitForIdle(): Promise<void> {
  // Use `setTimeout(0)` unconditionally instead of `requestIdleCallback`.
  //
  // `requestIdleCallback` is starved by the browser whenever the page is doing
  // sustained work (animations, setInterval-driven state updates, large React
  // commits) — even the documented `{ timeout: N }` escape hatch fails to fire
  // under heavy load (observed 11+ s waits for `timeout: 100` while a modal
  // animation was running). That deadlocked the chunked snapshot hydration in
  // store-sync's `storedInitialBlockLogs$` and prevented the live SSE stream
  // from ever opening on sync restart.
  //
  // `setTimeout(0)` reliably yields to the next macrotask, which is sufficient
  // for the original intent of this helper ("let rendering breathe between
  // hydration chunks").
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
