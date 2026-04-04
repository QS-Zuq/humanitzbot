/**
 * Typed dynamic import helpers for optional/ESM-incompatible dependencies.
 *
 * WHY dynamic imports are needed here:
 *   1. Optional dependencies (ssh2, ssh2-sftp-client) may not be installed in
 *      all deployments — static imports would fail at startup.
 *   2. CJS modules with `export =` syntax (e.g. ssh2-sftp-client) are not
 *      compatible with TypeScript's ESM interop when using `import type`, so
 *      `as unknown as` casts were previously required at every call site.
 *   3. Internal optional modules (anticheat-integration) are private packages
 *      that may be absent — dynamic import inside try/catch is the safe pattern.
 *
 * Each helper encapsulates the import() call + type extraction so call sites
 * stay clean and type-safe.
 */

// ── ssh2-sftp-client ──────────────────────────────────────────────────────────

import type SFTPClientLib from 'ssh2-sftp-client';

/** The SFTPClient constructor type extracted from the ssh2-sftp-client module. */
export type SFTPClientConstructor = typeof SFTPClientLib;

/**
 * Dynamically imports ssh2-sftp-client and returns its default export
 * (the SFTPClient constructor).
 *
 * @throws {Error} if ssh2-sftp-client is not installed
 */
export async function importSftpClient(): Promise<SFTPClientConstructor> {
  // ssh2-sftp-client uses `export =` (CJS), so ESM dynamic import wraps it
  // in a synthetic default — the cast through unknown is unavoidable here.
  const mod = (await import('ssh2-sftp-client')) as unknown as { default: SFTPClientConstructor };
  return mod.default;
}

// ── ssh2 ─────────────────────────────────────────────────────────────────────

import type { Client as SSH2Client } from 'ssh2';

/** The ssh2 Client constructor type. */
export type SSH2ClientConstructor = typeof SSH2Client;

/**
 * Dynamically imports ssh2 and returns its Client constructor.
 *
 * @throws {Error} if ssh2 is not installed
 */
export async function importSsh2Client(): Promise<SSH2ClientConstructor> {
  const mod = await import('ssh2');
  return mod.Client;
}

// ── agent-builder ─────────────────────────────────────────────────────────────

import type { buildAgentScript as BuildAgentScriptFn } from '../parsers/agent-builder.js';

/** The buildAgentScript function signature. */
export type BuildAgentScript = typeof BuildAgentScriptFn;

/**
 * Dynamically imports the agent-builder module and returns buildAgentScript.
 *
 * The agent-builder module uses esbuild internally — dynamic import ensures
 * esbuild is only loaded when agent deployment is actually requested.
 *
 * @throws {Error} if the module fails to load
 */
export async function importBuildAgentScript(): Promise<BuildAgentScript> {
  const mod = await import('../parsers/agent-builder.js');
  return mod.buildAgentScript;
}
