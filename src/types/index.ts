/**
 * Barrel re-export of public types from domain-scoped modules.
 */

export {
  API_PROXY_PORTS,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
} from './ports';

export type * from './wrapper-config';

export { type UpstreamProxyConfig } from './upstream-proxy';
export { type LogLevel } from './log-level';
export { type RateLimitConfig } from './rate-limit';
export { type FlagValidationResult } from './validation';

export {
  type SquidConfig,
} from './squid';

export {
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

export {
  type BoundedQueryRuntime,
  type BoundedQueryInterpreter,
  type BoundedQuerySensitivity,
  type BoundedQueryRepository,
  type BoundedQueriesConfig,
  type BoundedQueryOptions,
  BOUNDED_QUERY_DEFAULTS,
  BOUNDED_QUERY_SENSITIVITIES,
  BOUNDED_QUERY_SENSITIVITY_RUN_BITS,
} from './bounded-query-options';

export {
  type BoundedAgentRuntime,
  type BoundedAgentEngine,
  type BoundedAgentProfile,
  type BoundedAgentSensitivity,
  type BoundedAgentRepository,
  type BoundedAgentsConfig,
  type BoundedAgentOptions,
  BOUNDED_AGENT_DEFAULTS,
  BOUNDED_AGENT_ENGINES,
  BOUNDED_AGENT_PROFILES,
  BOUNDED_AGENT_SENSITIVITIES,
  BOUNDED_AGENT_SENSITIVITY_RUN_BITS,
} from './bounded-agent-options';

export {
  type EnclaveSensitivity,
  type EnclaveRepository,
  type EnclaveRuntime,
  type EnclaveScriptInterpreter,
  type EnclaveAgentEngine,
  type EnclaveAgentProfile,
  type EnclaveScriptExecutorConfig,
  type EnclaveAgentExecutorConfig,
  type EnclavesConfig,
  type EnclaveOptions,
  ENCLAVE_SENSITIVITIES,
  ENCLAVE_SENSITIVITY_RUN_BITS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVES_DEFAULTS,
} from './enclave-options';
