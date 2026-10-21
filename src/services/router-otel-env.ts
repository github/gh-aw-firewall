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

const OTLP_HEADERS_ENV_VAR = /^(?:AWF_ROUTER_)?OTEL_EXPORTER_OTLP_(?:(?:TRACES|METRICS)_)?HEADERS$/;
const OTLP_ENDPOINT_ENV_VAR = /^(?:AWF_ROUTER_)?OTEL_EXPORTER_OTLP_(?:(?:TRACES|METRICS)_)?ENDPOINT$/;
// The router trims settings with Go's strings.TrimSpace, so leading whitespace, including
// U+0085, which JavaScript's \s doesn't match, still leaves a usable endpoint.
const URL_USER_INFO = /^([\s\u0085]*[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

/**
 * Redacts an OTLP exporter setting for a compose snapshot: header values, which carry
 * collector credentials, entirely, whatever their type, and the user info of an endpoint URL.
 * Other values are returned unchanged.
 */
export function redactOtlpEnvValue(name: string, value: unknown): unknown {
  if (OTLP_HEADERS_ENV_VAR.test(name)) return '[REDACTED]';
  if (OTLP_ENDPOINT_ENV_VAR.test(name) && typeof value === 'string') {
    return value.replace(URL_USER_INFO, '$1[REDACTED]@');
  }
  return value;
}
