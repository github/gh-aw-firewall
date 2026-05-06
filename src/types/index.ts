/**
 * Barrel re-export of public types from domain-scoped modules.
 *
 * Note: DockerService, DockerNetwork, and DockerVolume are not re-exported
 * here; import them directly from './types/docker' if needed.
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
