import { OPENAI_ENV, ANTHROPIC_ENV, COPILOT_ENV, GEMINI_ENV, VERTEX_ENV } from '../api-proxy-env-constants';

export function assertDatabricksTargetsMatchWorkspace(targets: Readonly<Record<string, string>>, databricksHost: URL): void {
  for (const key of [
    OPENAI_ENV.TARGET, ANTHROPIC_ENV.TARGET, COPILOT_ENV.API_TARGET,
    GEMINI_ENV.TARGET, VERTEX_ENV.TARGET, COPILOT_ENV.PROVIDER_BASE_URL,
  ]) {
    const target = targets[key];
    if (!target) continue;
    let url: URL;
    try { url = new URL(target.includes('://') ? target : `https://${target}`); } catch {
      throw new Error('Invalid Databricks API target binding');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        ['api.openai.com', 'api.anthropic.com', 'githubcopilot.com'].includes(hostname) ||
        hostname.endsWith('.githubcopilot.com') ||
        (hostname.startsWith('copilot-api.') && hostname.endsWith('.ghe.com')) ||
        url.origin !== databricksHost.origin) {
      throw new Error('Databricks API target must match the configured HTTPS workspace origin');
    }
  }
}
