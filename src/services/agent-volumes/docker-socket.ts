import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

export function resolveDockerSocketPath(config: WrapperConfig): string {
  const dockerHost = config.awfDockerHost ?? process.env.DOCKER_HOST;
  if (!dockerHost) {
    return DEFAULT_DOCKER_SOCKET_PATH;
  }

  if (!dockerHost.startsWith('unix://')) {
    logger.debug(`Ignoring non-Unix Docker host for DinD socket mount: ${dockerHost}`);
    return DEFAULT_DOCKER_SOCKET_PATH;
  }

  const socketPath = dockerHost.slice('unix://'.length);
  if (socketPath.startsWith('/') && socketPath !== '/' && socketPath.trim() !== '') {
    return socketPath;
  }

  logger.warn(`Ignoring invalid unix Docker host path: ${dockerHost}`);
  return DEFAULT_DOCKER_SOCKET_PATH;
}

export function buildDockerSocketMount(config: WrapperConfig): string[] {
  if (config.enableDind) {
    logger.warn('Docker-in-Docker enabled: agent can run docker commands (firewall bypass possible)');
    const dockerSocketPath = resolveDockerSocketPath(config);
    const mounts = [`${dockerSocketPath}:/host${dockerSocketPath}:rw`];
    if (dockerSocketPath === DEFAULT_DOCKER_SOCKET_PATH) {
      mounts.push('/run/docker.sock:/host/run/docker.sock:rw');
    }
    logger.debug('Selective mounts configured: system paths (ro), home (rw), Docker socket exposed');
    return mounts;
  }

  logger.debug('Selective mounts configured: system paths (ro), home (rw), Docker socket hidden');
  return [
    '/dev/null:/host/var/run/docker.sock:ro',
    '/dev/null:/host/run/docker.sock:ro',
  ];
}
