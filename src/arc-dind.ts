import * as path from 'path';

export const ARC_DIND_BIND_PREFIX = '/tmp/gh-aw/arc-root';

const DEFAULT_DOCKER_HOST_SOCKETS = new Set([
  'unix:///var/run/docker.sock',
  'unix:///run/docker.sock',
]);

const ARC_DIND_PASSTHROUGH_PREFIXES = ['/dev', '/sys'];
const ARC_DIND_PASSTHROUGH_PATHS = new Set([
  '/var/run/docker.sock',
  '/run/docker.sock',
]);

export type ArcDindDockerHostDetection =
  | { detected: false }
  | {
      detected: true;
      dockerHost: string;
      reason: 'tcp' | 'non-default-unix-socket';
    };

export function detectArcDindDockerHost(
  env: Record<string, string | undefined> = process.env
): ArcDindDockerHostDetection {
  const dockerHost = env['DOCKER_HOST'];

  if (!dockerHost) {
    return { detected: false };
  }

  if (dockerHost.startsWith('unix://')) {
    if (DEFAULT_DOCKER_HOST_SOCKETS.has(dockerHost)) {
      return { detected: false };
    }

    return {
      detected: true,
      dockerHost,
      reason: 'non-default-unix-socket',
    };
  }

  return {
    detected: true,
    dockerHost,
    reason: 'tcp',
  };
}

export function translateArcDindBindSource(sourcePath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(sourcePath) || sourcePath.startsWith('\\\\')) {
    return sourcePath;
  }

  if (!path.posix.isAbsolute(sourcePath)) {
    return sourcePath;
  }

  if (sourcePath === '/') {
    return ARC_DIND_BIND_PREFIX;
  }

  if (ARC_DIND_PASSTHROUGH_PATHS.has(sourcePath)) {
    return sourcePath;
  }

  if (ARC_DIND_PASSTHROUGH_PREFIXES.some(prefix => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`))) {
    return sourcePath;
  }

  return path.posix.join(ARC_DIND_BIND_PREFIX, sourcePath.slice(1));
}
