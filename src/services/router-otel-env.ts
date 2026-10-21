/**
 * Router OpenTelemetry export settings.
 *
 * Operators opt in through router-specific `AWF_ROUTER_OTEL_<NAME>` host variables, which
 * reach the router as `OTEL_<NAME>`. The shared host `OTEL_*` variables configure the
 * api-proxy, usually for an external collector the router can't reach on its internal
 * network, so they are never forwarded to the router.
 */

export const ROUTER_OTEL_HOST_PREFIX = 'AWF_ROUTER_';

const OTLP_EXPORTER_SETTINGS = ['ENDPOINT', 'PROTOCOL', 'HEADERS', 'TIMEOUT', 'CERTIFICATE'];

/** The `OTEL_*` settings the router supports, in the form the router reads them. */
export const ROUTER_OTEL_SETTINGS: readonly string[] = [
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

/** The host variables that configure router export. None of them may reach the agent. */
export const ROUTER_OTEL_HOST_ENV_VARS: readonly string[] =
  ROUTER_OTEL_SETTINGS.map(name => ROUTER_OTEL_HOST_PREFIX + name);

/**
 * Builds the router's `OTEL_*` environment from the set, non-blank `AWF_ROUTER_OTEL_*`
 * host variables. Values are passed as they are; the router validates them.
 */
export function buildRouterOtelEnv(hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ROUTER_OTEL_SETTINGS) {
    const value = hostEnv[ROUTER_OTEL_HOST_PREFIX + name];
    if (value !== undefined && value.trim() !== '') environment[name] = value;
  }
  return environment;
}

const OTLP_HEADERS_ENV_VAR = /^(?:AWF_ROUTER_)?OTEL_EXPORTER_OTLP_(?:(?:TRACES|METRICS)_)?HEADERS$/;
const OTLP_ENDPOINT_ENV_VAR = /^(?:AWF_ROUTER_)?OTEL_EXPORTER_OTLP_(?:(?:TRACES|METRICS)_)?ENDPOINT$/;
const URL_USER_INFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

/**
 * Redacts an OTLP exporter setting for a compose snapshot: header values, which carry
 * collector credentials, entirely, and the user info of an endpoint URL. Other values are
 * returned unchanged.
 */
export function redactOtlpEnvValue(name: string, value: string): string {
  if (OTLP_HEADERS_ENV_VAR.test(name)) return '[REDACTED]';
  if (OTLP_ENDPOINT_ENV_VAR.test(name)) return value.replace(URL_USER_INFO, '$1[REDACTED]@');
  return value;
}
