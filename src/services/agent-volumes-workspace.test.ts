import { generateDockerCompose, WrapperConfig, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('should mount workspace directory under /host', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // SECURITY FIX: Should mount only workspace directory under /host (not entire HOME)
    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
    expect(volumes).toContain(`${workspaceDir}:/host${workspaceDir}:rw`);
  });

  describe('containerWorkDir option', () => {
    it('should not set working_dir when containerWorkDir is not specified', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);

      expect(result.services.agent.working_dir).toBeUndefined();
    });

    it('should set working_dir when containerWorkDir is specified', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '/home/runner/work/repo/repo',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      expect(result.services.agent.working_dir).toBe('/home/runner/work/repo/repo');
    });

    it('should set working_dir to /workspace when containerWorkDir is /workspace', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '/workspace',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      expect(result.services.agent.working_dir).toBe('/workspace');
    });

    it('should handle paths with special characters', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '/home/user/my-project with spaces',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      expect(result.services.agent.working_dir).toBe('/home/user/my-project with spaces');
    });

    it('should preserve working_dir alongside other agent service config', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '/custom/workdir',
        envAll: true,
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      // Verify working_dir is set
      expect(result.services.agent.working_dir).toBe('/custom/workdir');
      // Verify other config is still present
      expect(result.services.agent.container_name).toBe('awf-agent');
      expect(result.services.agent.cap_add).toContain('SYS_CHROOT');
    });

    it('should handle empty string containerWorkDir by not setting working_dir', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      // Empty string is falsy, so working_dir should not be set
      expect(result.services.agent.working_dir).toBeUndefined();
    });

    it('should handle absolute paths correctly', () => {
      const config: WrapperConfig = {
        ...getConfig(),
        containerWorkDir: '/var/lib/app/data',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);

      expect(result.services.agent.working_dir).toBe('/var/lib/app/data');
    });
  });
});
