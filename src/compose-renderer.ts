import * as yaml from 'js-yaml';
import { DockerComposeConfig } from './types';

/**
 * Renders literal environment values for Compose without changing the canonical
 * service objects shared with other runtimes. Commands already carry their own
 * Compose escaping and must be left alone.
 */
export function renderDockerCompose(compose: DockerComposeConfig): string {
  const services = Object.fromEntries(
    Object.entries(compose.services).map(([name, service]) => [
      name,
      service.environment ? {
        ...service,
        environment: Object.fromEntries(
          Object.entries(service.environment).map(([key, value]) => [
            key, typeof value === 'string' ? value.replace(/\$/g, () => '$$') : value,
          ]),
        ),
      } : service,
    ]),
  );
  // Disable wrapping so base64-encoded configuration remains on one line.
  return yaml.dump({ ...compose, services }, { lineWidth: -1 });
}
