/**
 * Safely extract error message from unknown catch variable and strip control
 * characters that could forge extra log lines (CWE-117 log injection).
 */
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\r\n\t]+/g, ' ');
}
