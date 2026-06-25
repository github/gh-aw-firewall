import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import { logger } from '../logger';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

function withEnv(envPatch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(envPatch)) {
    saved[key] = process.env[key];
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

describe('agent service', () => {
  it('should mount api-proxy health-check script when api-proxy is enabled', () => {
    const configWithApiProxy = {
      ...getConfig(),
      enableApiProxy: true,
    };
    const result = generateDockerCompose(configWithApiProxy, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContainEqual(expect.stringMatching(/containers\/agent\/api-proxy-health-check\.sh:\/usr\/local\/bin\/api-proxy-health-check\.sh:ro$/));
  });

  it('should apply dockerHostPathPrefix to api-proxy health-check script mount', () => {
    const configWithApiProxyAndPrefix = {
      ...getConfig(),
      enableApiProxy: true,
      dockerHostPathPrefix: '/daemon-root',
    };
    const result = generateDockerCompose(configWithApiProxyAndPrefix, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContainEqual(expect.stringMatching(/^\/daemon-root.*containers\/agent\/api-proxy-health-check\.sh:\/usr\/local\/bin\/api-proxy-health-check\.sh:ro$/));
  });

  it('should expose Docker socket when enableDind is true', () => {
    const dindConfig = { ...getConfig(), enableDind: true };
    const result = generateDockerCompose(dindConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Docker socket should be mounted read-write, not hidden
    expect(volumes).toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
    expect(volumes).toContain('/run/docker.sock:/host/run/docker.sock:rw');
    // Should NOT have /dev/null mounts
    expect(volumes).not.toContain('/dev/null:/host/var/run/docker.sock:ro');
    expect(volumes).not.toContain('/dev/null:/host/run/docker.sock:ro');
  });

  it('should expose the Unix DOCKER_HOST socket path when enableDind is true', () => {
    withEnv({ DOCKER_HOST: 'unix:///tmp/arc/docker.sock' }, () => {
      const dindConfig = { ...getConfig(), enableDind: true };
      const result = generateDockerCompose(dindConfig, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];

      expect(volumes).toContain('/tmp/arc/docker.sock:/host/tmp/arc/docker.sock:rw');
      expect(volumes).not.toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
      expect(volumes).not.toContain('/run/docker.sock:/host/run/docker.sock:rw');
    });
  });

  it('should preserve host DOCKER_HOST for agent env when enableDind is true', () => {
    withEnv({ DOCKER_HOST: 'unix:///tmp/arc/docker.sock' }, () => {
      const dindConfig = {
        ...getConfig(),
        enableDind: true,
        awfDockerHost: 'unix:///run/user/1000/docker.sock',
      };
      const result = generateDockerCompose(dindConfig, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];
      const env = result.services.agent.environment as Record<string, string>;

      expect(volumes).toContain('/run/user/1000/docker.sock:/host/run/user/1000/docker.sock:rw');
      expect(volumes).not.toContain('/tmp/arc/docker.sock:/host/tmp/arc/docker.sock:rw');
      expect(env.DOCKER_HOST).toBe('unix:///tmp/arc/docker.sock');
    });
  });

  it('should set agent DOCKER_HOST from awfDockerHost when enableDind is true and host DOCKER_HOST is unset', () => {
    withEnv({ DOCKER_HOST: undefined }, () => {
      const dindConfig = {
        ...getConfig(),
        enableDind: true,
        awfDockerHost: 'unix:///run/user/1000/docker.sock',
      };
      const result = generateDockerCompose(dindConfig, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];
      const env = result.services.agent.environment as Record<string, string>;

      expect(volumes).toContain('/run/user/1000/docker.sock:/host/run/user/1000/docker.sock:rw');
      expect(volumes).not.toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
      expect(volumes).not.toContain('/run/docker.sock:/host/run/docker.sock:rw');
      expect(env.DOCKER_HOST).toBe('unix:///run/user/1000/docker.sock');
    });
  });

  it('should warn and fall back to the default socket for an invalid Unix DOCKER_HOST path', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      withEnv({ DOCKER_HOST: 'unix://relative/path' }, () => {
        const dindConfig = { ...getConfig(), enableDind: true };
        const result = generateDockerCompose(dindConfig, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain('/var/run/docker.sock:/host/var/run/docker.sock:rw');
        expect(volumes).toContain('/run/docker.sock:/host/run/docker.sock:rw');
        expect(volumes).not.toContain('relative/path:/hostrelative/path:rw');
        expect(warnSpy).toHaveBeenCalledWith('Ignoring invalid unix Docker host path: unix://relative/path');
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
