/**
 * API proxy and CLI proxy port constants.
 *
 * The port values are centralized in src/config/sandbox-network-policy.json
 * (the single source of truth shared by all runtimes). This module adapts them
 * to the historical `API_PROXY_PORTS` / `API_PROXY_HEALTH_PORT` / `CLI_PROXY_PORT`
 * shape so existing import sites keep working unchanged.
 */

import {
  apiProxyPorts,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
} from '../config/network-policy';

const ports = apiProxyPorts();

/**
 * API Proxy port configuration.
 *
 * These ports are used by the api-proxy sidecar container to expose
 * authentication-injecting proxies for different LLM providers.
 *
 * All ports must be allowed in:
 * - containers/api-proxy/Dockerfile (EXPOSE directive)
 * - src/host-iptables.ts (firewall rules)
 * - containers/agent/setup-iptables.sh (NAT rules)
 */
export const API_PROXY_PORTS = {
  /** OpenAI API proxy port (also the healthcheck endpoint). */
  OPENAI: ports.openai,
  /** Anthropic (Claude) API proxy port. */
  ANTHROPIC: ports.anthropic,
  /** GitHub Copilot API proxy port. */
  COPILOT: ports.copilot,
  /** Google Gemini API proxy port. */
  GEMINI: ports.gemini,
  /** Google Vertex AI API proxy port. */
  VERTEX: ports.vertex,
} as const;

/**
 * Health check port for the API proxy sidecar.
 * Always uses the OpenAI port (10000) for Docker healthcheck.
 */
export { API_PROXY_HEALTH_PORT };

/**
 * Port for the CLI proxy sidecar HTTP server.
 *
 * The CLI proxy sidecar listens on this port for gh CLI invocations forwarded
 * from the agent container. Port 11000 is chosen to avoid collision with the
 * api-proxy ports (10000-10004).
 *
 * All ports must be allowed in:
 * - containers/cli-proxy/Dockerfile (EXPOSE directive)
 * - containers/agent/setup-iptables.sh (NAT rules)
 * @see containers/cli-proxy/server.js
 */
export { CLI_PROXY_PORT };
