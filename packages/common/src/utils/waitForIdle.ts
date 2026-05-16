// Yields to the next macrotask so React can render between bursts of work.
// `setTimeout(0)` is used instead of `requestIdleCallback` because the latter
// is starved on busy pages even with its `timeout` option set.
export function waitForIdle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
