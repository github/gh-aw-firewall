/**
 * GitHub-token-shaped Copilot placeholder used when api-proxy credential isolation is enabled.
 * The `ghu_` prefix plus 36 alphanumeric characters allows Copilot CLI auth prechecks to pass,
 * while real credentials remain isolated in the api-proxy sidecar and are injected only upstream.
 */
export const COPILOT_PLACEHOLDER_TOKEN = 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
