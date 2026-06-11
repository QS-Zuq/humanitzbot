/** Yield to the event loop so queued I/O can run between long synchronous phases. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
