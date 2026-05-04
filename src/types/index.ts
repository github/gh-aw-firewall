/**
 * Barrel re-export of all types from domain-scoped modules.
 *
 * This file ensures full backwards compatibility — all existing imports
 * from './types' or '../types' continue to work unchanged.
 */

export {
  API_PROXY_PORTS,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
  type LogLevel,
  type RateLimitConfig,
  type UpstreamProxyConfig,
  type WrapperConfig,
} from './config';

export {
  type SquidConfig,
  type DockerComposeConfig,
  type DockerService,
  type DockerNetwork,
  type DockerVolume,
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
