const MAX_RECONNECT_DELAY_MS = 300_000;
const RECONNECT_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, MAX_RECONNECT_DELAY_MS] as const;

class ReconnectBackoff {
  private _attempts: number;

  constructor() {
    this._attempts = 0;
  }

  nextDelayMs(): number {
    const delay = RECONNECT_DELAYS_MS[this._attempts];
    this._attempts++;
    return delay ?? MAX_RECONNECT_DELAY_MS;
  }

  reset(): void {
    this._attempts = 0;
  }
}

function formatReconnectDelay(delayMs: number): string {
  if (delayMs < 60_000) return `${String(delayMs / 1000)} seconds`;
  const minutes = delayMs / 60_000;
  return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export { ReconnectBackoff, formatReconnectDelay };
