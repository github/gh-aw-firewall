import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig, withEnv } from './service-test-setup.test-utils';
import { dockerSensitiveTmpfs } from '../sensitive-paths';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('masks GitLab credentials exposed through custom binds without duplicate mount targets', () => {
    const configDir = path.join(getConfig().workDir, 'gitlab-auth');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'config.yml'), 'DUMMY_GITLAB_TOKEN');
    fs.writeFileSync(path.join(configDir, 'aliases.yml'), 'benign-alias');
    withEnv({ GLAB_CONFIG_DIR: configDir }, () => {
      const config = {
        ...getConfig(),
        volumeMounts: [
          `${configDir}:/host/gitlab-auth:ro`,
          `${configDir}/config.yml:/host/gitlab-token.yml:ro`,
        ],
      };
      const volumes = generateDockerCompose(config, mockNetworkConfig).services.agent.volumes as string[];
      expect(volumes).toContain('/dev/null:/host/gitlab-auth/config.yml:ro');
      expect(volumes).toContain('/dev/null:/host/gitlab-token.yml:ro');
      expect(volumes).toContain(`${configDir}:/host/gitlab-auth:ro`);
      expect(volumes.filter((spec) => spec.split(':')[1] === '/host/gitlab-token.yml')).toHaveLength(1);
      expect(volumes.some((spec) => spec.startsWith('/dev/null:') && spec.includes('aliases.yml'))).toBe(false);
    });
  });

  it('should use selective mounts when no custom mounts specified', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Default: selective mounting (no blanket /:/host:rw)
    expect(volumes).not.toContain('/:/host:rw');
    // Should include selective mounts with credential hiding
    expect(volumes.some((v: string) => v.includes('/dev/null'))).toBe(true);
  });

  it('should hide Docker socket by default', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Docker socket should be hidden with /dev/null
    expect(volumes).toContain('/dev/null:/host/var/run/docker.sock:ro');
    expect(volumes).toContain('/dev/null:/host/run/docker.sock:ro');
  });

  describe('workDir tmpfs overlay (secrets protection)', () => {
    it('should hide workDir from agent container via tmpfs in normal mode', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);
      const agent = result.services.agent;
      const tmpfs = agent.tmpfs as string[];

      // workDir should be hidden via tmpfs overlay to prevent reading docker-compose.yml
      expect(tmpfs).toContainEqual(expect.stringContaining(getConfig().workDir));
      expect(tmpfs.some((t: string) => t.startsWith(`${getConfig().workDir}:`))).toBe(true);
    });

    it('should hide workDir at both normal and /host paths (chroot always on)', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);
      const agent = result.services.agent;
      const tmpfs = agent.tmpfs as string[];

      // Both /tmp/awf-test and /host/tmp/awf-test should be hidden
      expect(tmpfs.some((t: string) => t.startsWith(`${getConfig().workDir}:`))).toBe(true);
      expect(tmpfs.some((t: string) => t.startsWith(`/host${getConfig().workDir}:`))).toBe(true);
    });

    it('should still hide mcp-logs alongside workDir', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);
      const agent = result.services.agent;
      const tmpfs = agent.tmpfs as string[];

      // Both mcp-logs and workDir should be hidden
      expect(tmpfs.some((t: string) => t.includes('/tmp/gh-aw/mcp-logs'))).toBe(true);
      expect(tmpfs.some((t: string) => t.startsWith(`${getConfig().workDir}:`))).toBe(true);
    });

    it('should set secure tmpfs options (noexec, nosuid, size limit)', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);
      const agent = result.services.agent;
      const tmpfs = agent.tmpfs as string[];

      // All tmpfs mounts should have security options
      tmpfs.forEach((mount: string) => {
        expect(mount).toContain('noexec');
        expect(mount).toContain('nosuid');
        // Each mount must have a size limit (value varies: 1m for secrets, 65536k for /dev/shm)
        expect(mount).toMatch(/size=\d+[mk]/);
      });
    });

    it('should apply tmpfs overlay to custom workDir paths', () => {
      const customWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-workdir-'));
      const configWithCustomWorkDir = {
        ...getConfig(),
        workDir: customWorkDir,
      };
      try {
        const result = generateDockerCompose(configWithCustomWorkDir, mockNetworkConfig);
        const agent = result.services.agent;
        const tmpfs = agent.tmpfs as string[];

        expect(tmpfs.some((t: string) => t.startsWith(`${customWorkDir}:`))).toBe(true);
        expect(tmpfs.some((t: string) => t.startsWith(`/host${customWorkDir}:`))).toBe(true);
      } finally {
        fs.rmSync(customWorkDir, { recursive: true, force: true });
      }
    });

    it('should include registry overlays and the writable /host/dev/shm mount', () => {
      const result = generateDockerCompose(getConfig(), mockNetworkConfig);
      const agent = result.services.agent;
      const tmpfs = agent.tmpfs as string[];

      expect(tmpfs).toHaveLength(dockerSensitiveTmpfs(getConfig().workDir).length + 1);
      expect(tmpfs).toEqual(expect.arrayContaining(dockerSensitiveTmpfs(getConfig().workDir)));
      // Writable /dev/shm for POSIX semaphores (chroot makes /host/dev read-only)
      expect(tmpfs.some((t: string) => t.startsWith('/host/dev/shm:'))).toBe(true);
    });
  });
});
