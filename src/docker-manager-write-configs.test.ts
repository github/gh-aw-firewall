import { writeConfigs } from './config-writer';
import { WrapperConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';

import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host identity functions so chownSync uses the real uid/gid
// (on macOS, gid < 1000 gets clamped to 1000 which causes EPERM)
jest.mock('./host-env', () => {
  const actual = jest.requireActual('./host-env');
  return {
    ...actual,
    getSafeHostUid: () => String(process.getuid?.() ?? 1000),
    getSafeHostGid: () => String(process.getgid?.() ?? 1000),
  };
});

describe('docker-manager writeConfigs', () => {
  describe('writeConfigs', () => {
    const { getDir } = useTempDir();

    it('should create work directory if it does not exist', async () => {
      const newWorkDir = path.join(getDir(), 'new-work-dir');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: newWorkDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // Expected to fail if seccomp profile not found, but directories should still be created
      }

      expect(fs.existsSync(newWorkDir)).toBe(true);
    });

    it('should create agent-logs directory', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directories should still be created
      }

      expect(fs.existsSync(path.join(getDir(), 'agent-logs'))).toBe(true);
    });

    it('should create squid-logs directory', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directories should still be created
      }

      expect(fs.existsSync(path.join(getDir(), 'squid-logs'))).toBe(true);
    });

    it('should create /tmp/gh-aw/mcp-logs directory with world-writable permissions', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail, but directory should still be created
      }

      expect(fs.existsSync('/tmp/gh-aw/mcp-logs')).toBe(true);
      const stats = fs.statSync('/tmp/gh-aw/mcp-logs');
      expect(stats.isDirectory()).toBe(true);
      expect((stats.mode & 0o777).toString(8)).toBe('777');
    });

    it('should write squid.conf file', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com', 'example.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      await writeConfigs(config);

      const squidConfPath = path.join(getDir(), 'squid.conf');
      expect(fs.existsSync(squidConfPath)).toBe(true);
      const content = fs.readFileSync(squidConfPath, 'utf-8');
      expect(content).toContain('github.com');
      expect(content).toContain('example.com');
    });

    it('should write docker-compose.yml file', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      await writeConfigs(config);

      const dockerComposePath = path.join(getDir(), 'docker-compose.yml');
      expect(fs.existsSync(dockerComposePath)).toBe(true);
      const content = fs.readFileSync(dockerComposePath, 'utf-8');
      expect(content).toContain('awf-squid');
      expect(content).toContain('awf-agent');
    });

    it('should create work directory with restricted permissions (0o700)', async () => {
      const newWorkDir = path.join(getDir(), 'restricted-dir');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: newWorkDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail if seccomp profile not found
      }

      expect(fs.existsSync(newWorkDir)).toBe(true);
      const stats = fs.statSync(newWorkDir);
      expect((stats.mode & 0o777).toString(8)).toBe('700');
    });

    it('should write config files with correct permissions (squid.conf: 0o644, docker-compose.yml: 0o600)', async () => {
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      await writeConfigs(config);

      const squidConfPath = path.join(getDir(), 'squid.conf');
      expect(fs.existsSync(squidConfPath)).toBe(true);
      const squidStats = fs.statSync(squidConfPath);
      expect((squidStats.mode & 0o777).toString(8)).toBe('644');

      const dockerComposePath = path.join(getDir(), 'docker-compose.yml');
      expect(fs.existsSync(dockerComposePath)).toBe(true);
      const composeStats = fs.statSync(dockerComposePath);
      expect((composeStats.mode & 0o777).toString(8)).toBe('600');
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-proxy-logs');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
        proxyLogsDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      expect(fs.existsSync(proxyLogsDir)).toBe(true);
    });

    it('should create api-proxy-logs subdirectory inside proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-proxy-logs');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
        proxyLogsDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      const apiProxyLogsDir = path.join(proxyLogsDir, 'api-proxy-logs');
      expect(fs.existsSync(apiProxyLogsDir)).toBe(true);
    });

    it('should create proxyLogsDir with nested non-existent parents', async () => {
      const proxyLogsDir = path.join(getDir(), 'deeply', 'nested', 'proxy-logs');
      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
        proxyLogsDir,
      };

      try {
        await writeConfigs(config);
      } catch {
        // May fail after writing configs
      }

      expect(fs.existsSync(proxyLogsDir)).toBe(true);
    });

    it('should pre-create chroot home subdirectories with correct ownership', async () => {
      const fakeHome = path.join(getDir(), 'fakehome');
      fs.mkdirSync(fakeHome, { recursive: true });
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      process.env.HOME = fakeHome;
      delete process.env.SUDO_USER;

      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
      };

      try {
        await writeConfigs(config);

        const expectedDirs = [
          '.copilot', '.cache', '.config', '.local',
          '.anthropic', '.claude', '.cargo', '.rustup', '.npm', '.nvm',
        ];
        for (const dir of expectedDirs) {
          expect(fs.existsSync(path.join(fakeHome, dir))).toBe(true);
        }
        expect(fs.existsSync(path.join(fakeHome, '.gemini'))).toBe(false);
      } finally {
        if (originalHome !== undefined) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
        if (originalSudoUser !== undefined) {
          process.env.SUDO_USER = originalSudoUser;
        } else {
          delete process.env.SUDO_USER;
        }
      }
    });

    it('should pre-create ~/.gemini when geminiApiKey is configured', async () => {
      const fakeHome = path.join(getDir(), 'fakehome-gemini');
      fs.mkdirSync(fakeHome, { recursive: true });
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      process.env.HOME = fakeHome;
      delete process.env.SUDO_USER;

      const config: WrapperConfig = {
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: getDir(),
        geminiApiKey: 'AIza-test-key',
      };

      try {
        await writeConfigs(config);

        expect(fs.existsSync(path.join(fakeHome, '.gemini'))).toBe(true);
      } finally {
        if (originalHome !== undefined) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
        if (originalSudoUser !== undefined) {
          process.env.SUDO_USER = originalSudoUser;
        } else {
          delete process.env.SUDO_USER;
        }
      }
    });
  });
});
