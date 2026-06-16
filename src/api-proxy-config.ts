// Re-export facade — implementation lives in focused modules.
// Callers importing from this path continue to work unchanged.
export type { ApiProxyValidationResult } from './api-proxy-config-validation';
export { validateApiProxyConfig, validateAnthropicCacheTailTtl } from './api-proxy-config-validation';
export { emitApiProxyTargetWarnings, emitCliProxyStatusLogs, warnClassicPATWithCopilotModel } from './api-proxy-config-warnings';
export { resolveApiTargetsToAllowedDomains } from './api-proxy-config-domains';
