/**
 * Dedicated bounded-agent enclave network.
 *
 * The enclave is deliberately *not* a member of `awf-net` or `awf-ext`: it has
 * no Squid route, no general proxy, no DNS route to the internet, and no path
 * to the primary agent, the broker, the safe-outputs collector, the MCP
 * gateway, or the CLI proxy. Its only reachable peer is the AWF API proxy,
 * which is dedicated to bounded-agent traffic, joins a separate egress bridge,
 * and remains the only component holding real provider credentials. Its logs,
 * metrics, and quota state are never shared with the primary agent.
 *
 * The network is created by Compose with an explicit `name:` so the broker —
 * which launches enclaves with a fixed `docker run --network <name>` argument
 * vector — never has to derive a Compose project prefix at runtime.
 */

/** Compose key and concrete Docker network name for the enclave network. */
export const BOUNDED_AGENT_NETWORK = 'awf-bounded-agent';

/** Egress bridge joined only by the dedicated bounded-agent API proxy. */
export const BOUNDED_AGENT_EGRESS_NETWORK = 'awf-bounded-agent-egress';

/**
 * Fixed subnet for the enclave network.
 *
 * Deliberately disjoint from the `awf-net` subnet (172.30.0.0/24) and from the
 * bounded-query sbx ingress bridge so the two topologies can never alias.
 */
export const BOUNDED_AGENT_SUBNET = '172.31.0.0/24';

/** Fixed API proxy address on the enclave network. */
export const BOUNDED_AGENT_API_PROXY_IP = '172.31.0.30';

/**
 * Fixed DNS alias for the API proxy on the enclave network.
 *
 * The enclave addresses the proxy by IP (Docker's embedded resolver is not
 * guaranteed to be reachable from every runtime), but the alias is published
 * so operators can reason about the topology and so a future runtime that does
 * have DNS keeps working without a protocol change.
 */
export const BOUNDED_AGENT_API_PROXY_ALIAS = 'awf-bounded-agent-api-proxy';
