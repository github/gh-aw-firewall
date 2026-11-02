import * as yaml from 'js-yaml';

// Keep only bounded control values; a safe-looking name alone does not make a value safe.
const SAFE_COMPOSE_ENV_VALUES = new Map<string, readonly string[]>([
  ['AWF_CHROOT_ENABLED', ['true', 'false']],
  ['AWF_DOH_ENABLED', ['true', 'false']],
  ['AWF_SSL_BUMP_ENABLED', ['true', 'false']],
  ['OTEL_SDK_DISABLED', ['true', 'false']],
  ['OTEL_EXPORTER_OTLP_PROTOCOL', ['grpc', 'http/protobuf', 'http/json']],
  ['OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', ['grpc', 'http/protobuf', 'http/json']],
  ['OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', ['grpc', 'http/protobuf', 'http/json']],
  ['OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', ['grpc', 'http/protobuf', 'http/json']],
]);

function redactComposeEnvValue(name: string, value: unknown): string {
  return typeof value === 'string' && SAFE_COMPOSE_ENV_VALUES.get(name)?.includes(value)
    ? value : '[REDACTED]';
}

/** Only use on snapshot copies; runtime configuration must retain its original values. */
export function redactComposeServiceEnvironment(service: { environment?: unknown }): void {
  const environment = service.environment;
  if (Array.isArray(environment)) {
    service.environment = environment.map(entry => {
      if (typeof entry !== 'string') return '[REDACTED]';
      const separatorIndex = entry.indexOf('=');
      const key = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? undefined : entry.slice(separatorIndex + 1);
      return `${key}=${redactComposeEnvValue(key, value)}`;
    });
  } else if (environment && typeof environment === 'object') {
    service.environment = Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [key, redactComposeEnvValue(key, value)]),
    );
  } else if ('environment' in service) {
    service.environment = '[REDACTED]';
  }
}

export function sanitizeDockerComposeYaml(raw: string): string {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    return raw;
  }

  const compose = parsed as Record<string, unknown>;
  const services = compose.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return yaml.dump(compose, { lineWidth: -1 });
  }

  for (const service of Object.values(services as Record<string, unknown>)) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      continue;
    }

    redactComposeServiceEnvironment(service as Record<string, unknown>);
  }

  return yaml.dump(compose, { lineWidth: -1 });
}
