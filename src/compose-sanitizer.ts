import * as yaml from 'js-yaml';
import { redactOtlpEnvValue } from './services/router-otel-env';

function isSensitiveComposeEnvVar(name: string): boolean {
  return /(TOKEN|KEY|SECRET)/i.test(name);
}

function sanitizeComposeEnvValue(name: string, value: unknown): unknown {
  if (isSensitiveComposeEnvVar(name)) return '[REDACTED]';
  return typeof value === 'string' ? redactOtlpEnvValue(name, value) : value;
}

function sanitizeComposeEnvironment(environment: unknown): void {
  if (Array.isArray(environment)) {
    for (let i = 0; i < environment.length; i++) {
      const entry = environment[i];
      if (typeof entry !== 'string') {
        continue;
      }

      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = entry.slice(0, separatorIndex);
      environment[i] = `${key}=${sanitizeComposeEnvValue(key, entry.slice(separatorIndex + 1))}`;
    }
    return;
  }

  if (environment && typeof environment === 'object') {
    const values = environment as Record<string, unknown>;
    for (const key of Object.keys(values)) {
      values[key] = sanitizeComposeEnvValue(key, values[key]);
    }
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

    const serviceConfig = service as Record<string, unknown>;
    if ('environment' in serviceConfig) {
      sanitizeComposeEnvironment(serviceConfig.environment);
    }
  }

  return yaml.dump(compose, { lineWidth: -1 });
}
