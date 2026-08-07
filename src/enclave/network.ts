/**
 * Dedicated network for the unified enclave agent executor.
 *
 * An agent enclave is deliberately *not* a member of `awf-net` or `awf-ext`:
 * it has no Squid route, no general proxy, no DNS route to the internet, and
 * no path to the primary agent, the enclave MCP server, the safe-outputs
 * collector, the MCP gateway, or the CLI proxy. Its only reachable peer is a
 * dedicated AWF API proxy instance that joins a separate egress bridge and is
 * the only component holding a real provider credential. That proxy's logs,
 * metrics, and quota state are private to this subsystem.
 *
 * The enclave MCP server that *launches* these enclaves never joins this
 * network. It joins only the separate internal MCP control network and reaches
 * the Docker daemon through a bind-mounted Unix socket.
 *
 * The network is created by Compose with an explicit `name:` so the server —
 * which launches enclaves with a fixed `docker run --network <name>` argument
 * vector — never has to derive a Compose project prefix at runtime.
 */

/** Compose key and concrete Docker network name for the agent-enclave network. */
export const ENCLAVE_AGENT_NETWORK = 'awf-enclave-agent';

/** Egress bridge joined only by the dedicated agent-enclave API proxy. */
export const ENCLAVE_AGENT_EGRESS_NETWORK = 'awf-enclave-agent-egress';

/**
 * Private control network shared only by the AWF-owned enclave MCP server and
 * the externally launched trusted MCP gateway.
 */
export const ENCLAVE_MCP_CONTROL_NETWORK = 'awf-enclave-mcp-control';

/** Stable upstream identity used in compiler-generated mcpg configuration. */
export const ENCLAVE_MCP_CONTROL_ALIAS = 'awf-enclave-mcp';

/** Streamable HTTP port reachable only on {@link ENCLAVE_MCP_CONTROL_NETWORK}. */
export const ENCLAVE_MCP_CONTROL_PORT = 8080;

/**
 * Fixed subnet for the agent-enclave network.
 *
 * Deliberately disjoint from the `awf-net` subnet (172.30.0.0/24).
 */
export const ENCLAVE_AGENT_SUBNET = '172.31.0.0/24';

/** Fixed API-proxy address on the agent-enclave network. */
export const ENCLAVE_AGENT_API_PROXY_IP = '172.31.0.30';

/**
 * Fixed DNS alias for the API proxy on the agent-enclave network.
 *
 * The enclave addresses the proxy by IP (Docker's embedded resolver is not
 * guaranteed to be reachable from every runtime), but the alias is published
 * so operators can reason about the topology.
 */
export const ENCLAVE_AGENT_API_PROXY_ALIAS = 'awf-enclave-agent-api-proxy';
