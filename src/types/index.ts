/**
 * Barrel re-export of public types from domain-scoped modules.
 */

export {
  API_PROXY_PORTS,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
} from './ports';

export {
  type WrapperConfig,
} from './wrapper-config';

export { type UpstreamProxyConfig } from './upstream-proxy';
export { type LogLevel } from './log-level';
export { type RateLimitConfig } from './rate-limit';

export {
  type SquidConfig,
  type DockerComposeConfig,
} from './docker';

export {
  type PolicyRule,
  type PolicyManifest,
} from './policy';

export {
  type BlockedTarget,
  type ParsedLogEntry,
  type OutputFormat,
  type LogStatsFormat,
  type LogSource,
  type EnhancedLogEntry,
} from './logging';

export {
  type PidTrackResult,
} from './pid';
