/**
 * API proxy and CLI proxy port constants.
 */

/**
 * API Proxy port configuration
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
  /**
   * OpenAI API proxy port
   * Also serves as the health check endpoint for Docker healthcheck
   * @see containers/api-proxy/server.js
   */
  OPENAI: 10000,

  /**
   * Anthropic (Claude) API proxy port
   * @see containers/api-proxy/server.js
   */
  ANTHROPIC: 10001,

  /**
   * GitHub Copilot API proxy port
   * @see containers/api-proxy/server.js
   */
  COPILOT: 10002,

  /**
   * Google Gemini API proxy port
   * @see containers/api-proxy/server.js
   */
  GEMINI: 10003,

} as const;

/**
 * Health check port for the API proxy sidecar
 * Always uses the OpenAI port (10000) for Docker healthcheck
 */
export const API_PROXY_HEALTH_PORT = API_PROXY_PORTS.OPENAI;

/**
 * Port for the CLI proxy sidecar HTTP server.
 *
 * The CLI proxy sidecar listens on this port for gh CLI invocations forwarded
 * from the agent container. Port 11000 is chosen to avoid collision with the
 * api-proxy ports (10000-10003).
 *
 * All ports must be allowed in:
 * - containers/cli-proxy/Dockerfile (EXPOSE directive)
 * - containers/agent/setup-iptables.sh (NAT rules)
 * @see containers/cli-proxy/server.js
 */
export const CLI_PROXY_PORT = 11000;
