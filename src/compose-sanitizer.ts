import * as yaml from 'js-yaml';

function isSensitiveComposeEnvVar(name: string): boolean {
  return /(TOKEN|KEY|SECRET)/i.test(name);
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
      if (isSensitiveComposeEnvVar(key)) {
        environment[i] = `${key}=[REDACTED]`;
      }
    }
    return;
  }

  if (environment && typeof environment === 'object') {
    const values = environment as Record<string, unknown>;
    for (const key of Object.keys(values)) {
      if (isSensitiveComposeEnvVar(key)) {
        values[key] = '[REDACTED]';
      }
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
