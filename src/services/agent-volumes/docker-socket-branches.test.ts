/**
 * Branch-coverage tests for agent-volumes/docker-socket.ts.
 *
 * Targets the previously uncovered path:
 *   Lines 13-14: dockerHost is set but does not start with 'unix://' →
 *                logger.debug + return DEFAULT_DOCKER_SOCKET_PATH
 */

import { buildDockerSocketMount } from './docker-socket';
import { WrapperConfig } from '../../types';

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

describe('buildDockerSocketMount – non-Unix docker host branch', () => {
  it('returns default socket mounts when awfDockerHost uses tcp:// scheme (non-unix)', () => {
    const config = makeConfig({ enableDind: true, awfDockerHost: 'tcp://192.168.1.5:2376' });
    const mounts = buildDockerSocketMount(config);

    // Falls back to DEFAULT_DOCKER_SOCKET_PATH which is /var/run/docker.sock
    expect(mounts).toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
    expect(mounts).toContain('/run/docker.sock:/host/run/docker.sock:rw');
  });

  it('returns default socket mounts when DOCKER_HOST env is tcp:// scheme (non-unix)', () => {
    const original = process.env.DOCKER_HOST;
    try {
      process.env.DOCKER_HOST = 'tcp://docker-host:2375';
      const config = makeConfig({ enableDind: true });
      const mounts = buildDockerSocketMount(config);

      expect(mounts).toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
    } finally {
      if (original === undefined) {
        delete process.env.DOCKER_HOST;
      } else {
        process.env.DOCKER_HOST = original;
      }
    }
  });
});
