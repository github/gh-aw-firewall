/**
 * Container names used in Docker Compose and referenced by docker CLI commands.
 * Extracted as constants so that generateDockerCompose() and helpers like
 * fastKillAgentContainer() stay in sync.
 */
export const AGENT_CONTAINER_NAME = 'awf-agent';
export const SQUID_CONTAINER_NAME = 'awf-squid';
export const IPTABLES_INIT_CONTAINER_NAME = 'awf-iptables-init';
export const API_PROXY_CONTAINER_NAME = 'awf-api-proxy';
export const DOH_PROXY_CONTAINER_NAME = 'awf-doh-proxy';
export const CLI_PROXY_CONTAINER_NAME = 'awf-cli-proxy';

// SQUID_PORT is centralized in src/config/sandbox-network-policy.json and
// re-exported here so existing import sites keep working unchanged.
export { SQUID_PORT } from './config/network-policy';

/**
 * Maximum size (bytes) of a single environment variable value allowed through
 * --env-all passthrough. Variables exceeding this are skipped with a warning
 * to prevent E2BIG errors from ARG_MAX exhaustion.
 */
export const MAX_ENV_VALUE_SIZE = 64 * 1024; // 64 KB

/**
 * Total environment size (bytes) threshold for issuing an ARG_MAX warning.
 * Linux ARG_MAX is ~2 MB for argv + envp combined; warn well before that.
 */
export const ENV_SIZE_WARNING_THRESHOLD = 1_500_000; // ~1.5 MB
