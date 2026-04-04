declare module '@humanitzbot/qs-anticheat' {
  export function init(config: Record<string, unknown>): void;
  export function check(data: Record<string, unknown>): Promise<unknown>;
  const _default: { init: typeof init; check: typeof check };
  export default _default;
}
