// ── Setup Prerequisite Checks ─────────────────────────────────
// Pure, side-effect-free helper module for setup.js.
// MUST NOT require config.js, dotenv, or any src/ module.
// Only reads process.env — no initialisation triggered.

interface PrerequisiteIssue {
  key: string;
  label: string;
  type: 'missing' | 'warning';
}

interface CheckOpts {
  skipSftp?: boolean;
}

interface RconResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Check that required environment keys are present before setup runs.
 * Also checks legacy FTP_* fallback env vars (warns about rename).
 */
export function checkPrerequisites(opts: CheckOpts = {}): PrerequisiteIssue[] {
  const issues: PrerequisiteIssue[] = [];

  // Required Discord keys
  const discordKeys = [
    { env: 'DISCORD_TOKEN', label: 'Discord Bot Token' },
    { env: 'DISCORD_CLIENT_ID', label: 'Discord Client ID' },
    { env: 'DISCORD_GUILD_ID', label: 'Discord Guild ID' },
  ];
  for (const { env, label } of discordKeys) {
    const val = process.env[env];
    if (!val || val.startsWith('your_')) {
      issues.push({ key: env, label, type: 'missing' });
    }
  }

  // SFTP credentials (with FTP_* backward compatibility)
  if (!opts.skipSftp) {
    // Required: SFTP_HOST and SFTP_USER (or their FTP_* fallbacks)
    for (const suffix of ['HOST', 'USER'] as const) {
      const sftpVal = process.env[`SFTP_${suffix}`];
      const ftpVal = process.env[`FTP_${suffix}`];
      const val = sftpVal ?? ftpVal;
      if (!val || val.startsWith('your_')) {
        issues.push({
          key: `SFTP_${suffix}`,
          label: suffix === 'HOST' ? 'SFTP Host' : 'SFTP Username',
          type: 'missing',
        });
      } else if (!sftpVal && ftpVal) {
        issues.push({ key: `FTP_${suffix}`, label: `FTP_${suffix} → rename to SFTP_${suffix}`, type: 'warning' });
      }
    }

    // Credentials: require SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH (at least one)
    const sftpPassword = process.env.SFTP_PASSWORD;
    const ftpPassword = process.env.FTP_PASSWORD;
    const password = sftpPassword ?? ftpPassword;
    const sftpKeyPath = process.env.SFTP_PRIVATE_KEY_PATH;
    const ftpKeyPath = process.env.FTP_PRIVATE_KEY_PATH;
    const keyPath = sftpKeyPath ?? ftpKeyPath;

    const hasPassword = password != null && !password.startsWith('your_');
    const hasKeyPath = keyPath != null && !keyPath.startsWith('your_');

    if (!hasPassword && !hasKeyPath) {
      issues.push({ key: 'SFTP_PASSWORD', label: 'SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH', type: 'missing' });
    } else if (hasPassword && !sftpPassword && ftpPassword) {
      issues.push({ key: 'FTP_PASSWORD', label: 'FTP_PASSWORD → rename to SFTP_PASSWORD', type: 'warning' });
    }
  }

  // RCON credentials (warning, not blocking)
  for (const env of ['RCON_HOST', 'RCON_PASSWORD']) {
    const val = process.env[env];
    if (!val || val.startsWith('your_')) {
      issues.push({ key: env, label: env, type: 'warning' });
    }
  }

  return issues;
}

/**
 * Attempt a TCP connection to the configured RCON endpoint.
 * Returns a structured result with error details on failure.
 */
export async function testRconReachability(): Promise<RconResult> {
  const host = process.env.RCON_HOST;
  const port = parseInt(process.env.RCON_PORT ?? '', 10) || 27015;
  const password = process.env.RCON_PASSWORD;

  if (!host || !password || host.startsWith('your_') || password.startsWith('your_')) {
    console.warn('[SETUP] RCON not configured — skipping connection test');
    return { ok: false, error: 'NOT_CONFIGURED', message: 'RCON not configured' };
  }

  console.log(`[SETUP] Testing RCON connection to ${host}:${String(port)}...`);

  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 10_000;

    const timer = setTimeout(() => {
      socket.destroy();
      console.warn('[SETUP] RCON connection timed out');
      resolve({ ok: false, error: 'TIMEOUT', message: 'Connection timed out after 10s' });
    }, timeout);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      console.log('[SETUP] RCON connection successful ✓');
      resolve({ ok: true });
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      console.warn(`[SETUP] RCON connection failed: ${err.message}`);
      resolve({ ok: false, error: err.code ?? 'UNKNOWN', message: err.message });
    });
  });
}
