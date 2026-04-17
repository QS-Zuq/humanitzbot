/**
 * Pure helper deciding whether/how the web panel should start at boot.
 * Extracted from src/index.ts so the branch logic can be unit-tested
 * without booting the Discord client or Express.
 */

export type WebPanelMode = 'oauth' | 'landingOnly';

export type WebPanelPlan =
  | { action: 'disabled'; reason: 'noPort' }
  | { action: 'start'; port: number; mode: WebPanelMode };

interface PlanEnv {
  WEB_MAP_PORT?: string;
  WEB_MAP_CALLBACK_URL?: string;
}

interface PlanConfig {
  discordClientSecret?: string;
}

function planWebPanelStartup(env: PlanEnv, config: PlanConfig): WebPanelPlan {
  const port = parseInt(env.WEB_MAP_PORT ?? '', 10);
  if (!port) return { action: 'disabled', reason: 'noPort' };

  const oauthConfigured = !!(config.discordClientSecret && env.WEB_MAP_CALLBACK_URL);
  return { action: 'start', port, mode: oauthConfigured ? 'oauth' : 'landingOnly' };
}

export { planWebPanelStartup };
export type { PlanEnv, PlanConfig };
