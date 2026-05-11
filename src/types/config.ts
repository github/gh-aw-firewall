/**
 * Backward-compatible re-exports for config types and constants.
 */

export {
  API_PROXY_PORTS,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
} from './ports';

export {
  type WrapperConfig,
  type ContainerImageOptions,
  type NetworkOptions,
  type VolumeOptions,
  type SecurityOptions,
  type ApiProxyOptions,
  type RateLimitOptions,
  type RuntimeOptions,
} from './wrapper-config';

export { type UpstreamProxyConfig } from './upstream-proxy';
export { type LogLevel } from './log-level';
export { type RateLimitConfig } from './rate-limit';
