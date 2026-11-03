/**
 * Router OpenTelemetry export settings.
 *
 * Operators opt in through router-specific `AWF_ROUTER_OTEL_<NAME>` host variables, which
 * reach the router as `OTEL_<NAME>`. The shared host `OTEL_*` variables configure the
 * api-proxy, usually for an external collector the router can't reach on its internal
 * network, so they are never forwarded to the router.
 */

const ROUTER_OTEL_HOST_PREFIX = 'AWF_ROUTER_';

const OTLP_EXPORTER_SETTINGS = ['ENDPOINT', 'PROTOCOL', 'HEADERS', 'TIMEOUT', 'CERTIFICATE'];

/** The `OTEL_*` settings the router supports, in the form the router reads them. */
const ROUTER_OTEL_SETTINGS: readonly string[] = [
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SDK_DISABLED',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRIC_EXPORT_TIMEOUT',
  ...['', 'TRACES_', 'METRICS_'].flatMap(signal =>
    OTLP_EXPORTER_SETTINGS.map(setting => `OTEL_EXPORTER_OTLP_${signal}${setting}`)),
];

/**
 * Whether a variable is in the reserved `AWF_ROUTER_OTEL_*` namespace, including names AWF
 * doesn't forward. None of them may reach the agent.
 */
export function isRouterOtelHostEnvVar(name: string): boolean {
  return name.startsWith(`${ROUTER_OTEL_HOST_PREFIX}OTEL_`);
}

/**
 * Builds the router's `OTEL_*` environment from the set, non-blank `AWF_ROUTER_OTEL_*`
 * host variables. Values are passed as they are; the router validates them.
 */
export function buildRouterOtelEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ROUTER_OTEL_SETTINGS) {
    const value = hostEnv[ROUTER_OTEL_HOST_PREFIX + name];
    if (value !== undefined && value.trim() !== '') environment[name] = value;
  }
  return environment;
}
