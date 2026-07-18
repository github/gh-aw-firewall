/**
 * Loopback addresses that are always excluded from proxy routing.
 * All three proxy environments (agent, api-proxy, cli-proxy) share this baseline.
 */
const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Builds the NO_PROXY / no_proxy value from loopback defaults and any
 * service-specific additional host bypasses.
 *
 * @param additionalHosts - Extra hosts/IPs to exclude from proxy routing.
 */
export function buildNoProxyValue(additionalHosts: string[] = []): string {
  return [...LOOPBACK_NO_PROXY_HOSTS, ...additionalHosts.filter(Boolean)].join(',');
}

/**
 * Returns `{ NO_PROXY, no_proxy }` set to the same value, composed from the
 * loopback defaults and any service-specific additional host bypasses.
 *
 * Using this helper keeps `NO_PROXY`/`no_proxy` behaviour consistent across the
 * agent, api-proxy, and cli-proxy environment builders and avoids bypass regressions.
 *
 * @param additionalHosts - Extra hosts/IPs to exclude from proxy routing.
 */
export function buildNoProxyEnv(additionalHosts: string[] = []): { NO_PROXY: string; no_proxy: string } {
  const value = buildNoProxyValue(additionalHosts);
  return { NO_PROXY: value, no_proxy: value };
}
