/**
 * bot-state-mode.ts — Schema validation mode for BotStateRepository.
 *
 * Three modes:
 *   off      — skip validation entirely; behave like the original getStateJSON (default for
 *              production and unknown NODE_ENV)
 *   dry-run  — run normalizer, emit shape-invalid event, **return raw parsed value** so callers
 *              observe real-world shapes during the observation period (default for staging)
 *   enforce  — run normalizer, emit shape-invalid event, return partial-recovery shape (default
 *              for test; same return value as dry-run for Option E — partial recovery always
 *              returns shape, not the original default)
 *
 * Mode resolution (startup-frozen):
 *   1. BOT_STATE_SCHEMA_MODE env var (if set) → exact value
 *   2. NODE_ENV:  production → off  |  staging → dry-run  |  test → enforce  |  other → off
 *
 * NOTE (dry-run mitigation — see temp/pr2-schema-spike.md §Q11):
 *   In dry-run mode getStateJSONValidated returns the **raw** parsed value, which may not match the
 *   schema shape.  Callers MUST defensively guard all field access (optional chaining, Array.isArray
 *   checks, typeof checks) to avoid TypeError crashes on unexpected shapes.
 */

export type SchemaMode = 'off' | 'dry-run' | 'enforce';

let _cached: SchemaMode | undefined;

function _resolve(): SchemaMode {
  const explicit = process.env.BOT_STATE_SCHEMA_MODE;
  if (explicit === 'off' || explicit === 'dry-run' || explicit === 'enforce') {
    return explicit;
  }
  const env = process.env.NODE_ENV;
  if (env === 'production') return 'off';
  if (env === 'staging') return 'dry-run';
  if (env === 'test') return 'enforce';
  return 'off';
}

/**
 * Returns the schema validation mode, caching the result on first call
 * (startup-frozen).  Changes to process.env after this point are ignored
 * unless reloadSchemaMode() is called explicitly.
 */
export function getSchemaMode(): SchemaMode {
  if (_cached === undefined) {
    _cached = _resolve();
  }
  return _cached;
}

/**
 * Test helper — clear the cached mode so the next call to getSchemaMode()
 * re-reads process.env.  This exists purely for unit tests that need to
 * exercise multiple modes in the same process.
 */
export function reloadSchemaMode(): void {
  _cached = undefined;
}
