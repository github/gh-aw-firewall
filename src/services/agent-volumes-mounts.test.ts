import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import { logger } from '../logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stageHostFile } from './agent-volumes/docker-host-staging';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
import { mockExecaSync } from '../test-helpers/mock-execa.test-utils';
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
  it('should mount required volumes in agent container (default behavior)', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Default: selective mounting (no blanket /:/host:rw)
    expect(volumes).not.toContain('/:/host:rw');
    expect(volumes).toContain('/tmp:/tmp:rw');
    expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
    // Should include home directory mount
    expect(volumes.some((v: string) => v.includes(process.env.HOME || '/root'))).toBe(true);
    // Should include credential hiding mounts
    expect(volumes.some((v: string) => v.includes('/dev/null') && v.includes('.docker/config.json'))).toBe(true);
  });

  it('should use custom volume mounts when specified', () => {
    const configWithMounts = {
      ...getConfig(),
      volumeMounts: ['/workspace:/workspace:ro', '/data:/data:rw'],
    };
    const result = generateDockerCompose(configWithMounts, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should NOT include blanket /:/host:rw mount
    expect(volumes).not.toContain('/:/host:rw');

    // Should include custom mounts (prefixed with /host for chroot visibility)
    expect(volumes).toContain('/workspace:/host/workspace:ro');
    expect(volumes).toContain('/data:/host/data:rw');

    // Should still include essential mounts
    expect(volumes).toContain('/tmp:/tmp:rw');
    expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
  });

  it('should apply dockerHostPathPrefix to bind-mount source paths', () => {
    const configWithPrefix = {
      ...getConfig(),
      dockerHostPathPrefix: '/daemon-root',
      volumeMounts: ['/workspace:/workspace:ro'],
    };
    const result = generateDockerCompose(configWithPrefix, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain('/daemon-root/tmp:/tmp:rw');
    expect(volumes).toContain('/daemon-root/usr:/host/usr:ro');
    expect(volumes).toContain('/daemon-root/etc/passwd:/host/etc/passwd:ro');
    expect(volumes).toContain('/daemon-root/workspace:/host/workspace:ro');
    expect(volumes).toContain('/dev/null:/host/var/run/docker.sock:ro');
    expect(volumes).toContain('/dev/null:/host/run/docker.sock:ro');
    expect(volumes.some((v: string) => v.startsWith(`/daemon-root${getConfig().workDir}/chroot-`) && v.endsWith(':/host/etc/hosts:ro'))).toBe(true);

    // Kernel virtual filesystems should NOT be prefixed — they are daemon-local
    expect(volumes).toContain('/dev:/host/dev:ro');
    expect(volumes).toContain('/sys:/host/sys:ro');
    expect(volumes).not.toContain('/daemon-root/dev:/host/dev:ro');
    expect(volumes).not.toContain('/daemon-root/sys:/host/sys:ro');
  });

  it('should normalize trailing slash in dockerHostPathPrefix', () => {
    const configWithPrefix = {
      ...getConfig(),
      dockerHostPathPrefix: '/daemon-root/',
    };
    const result = generateDockerCompose(configWithPrefix, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain('/daemon-root/tmp:/tmp:rw');
  });

  it('should auto-stage the ARC/DinD manual bootstrap files under a shared /tmp docker-host-path-prefix', () => {
    const originalPath = process.env.PATH;
    const sharedTmpPrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    const fakeBinDir = path.join(getConfig().workDir, 'fake-bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeCopilotPath = path.join(fakeBinDir, 'copilot');
    fs.writeFileSync(fakeCopilotPath, '#!/bin/sh\necho copilot\n', { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;
    mockExecaSync.mockImplementation((command: string, args?: string[]) => {
      if (command === 'docker' && args?.[0] === 'network' && args[1] === 'inspect') {
        return { stdout: '172.17.0.1', stderr: '', exitCode: 0 };
      }
      throw new Error('Not found');
    });

    try {
      const configWithTmpPrefix = {
        ...getConfig(),
        dockerHostPathPrefix: sharedTmpPrefix,
        agentCommand: 'copilot --version',
        enableHostAccess: true,
      };
      const result = generateDockerCompose(configWithTmpPrefix, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];
      const stageRoot = path.join(sharedTmpPrefix, 'awf-docker-host-stage');
      const stagedBinaryPath = path.join(stageRoot, 'bin/copilot');
      const hostsVolume = volumes.find((v: string) => v.endsWith(':/host/etc/hosts:ro'));
      const passwdVolume = volumes.find((v: string) => v.endsWith(':/host/etc/passwd:ro'));
      const groupVolume = volumes.find((v: string) => v.endsWith(':/host/etc/group:ro'));

      // passwd and group are staged under stageRoot — either at etc/passwd (direct copy)
      // or identity-XXXXX/passwd (synthesized when host UID not found in staged file)
      expect(passwdVolume).toBeDefined();
      expect(passwdVolume?.startsWith(stageRoot)).toBe(true);
      expect(groupVolume).toBeDefined();
      expect(groupVolume?.startsWith(stageRoot)).toBe(true);
      expect(volumes).toContain(`${stagedBinaryPath}:/tmp/awf-runner-bin/copilot:ro`);
      expect(hostsVolume).toBeDefined();
      expect(hostsVolume?.startsWith(`${stageRoot}/chroot-`)).toBe(true);

      const stagedPasswdPath = passwdVolume!.split(':')[0];
      const stagedGroupPath = groupVolume!.split(':')[0];
      // Staged passwd must contain the host UID (either copied or synthesized)
      const { getSafeHostUid } = jest.requireActual('../host-identity') as typeof import('../host-identity');
      const uid = getSafeHostUid();
      expect(fs.readFileSync(stagedPasswdPath, 'utf8')).toMatch(new RegExp(`^[^:]*:[^:]*:${uid}:`, 'm'));
      expect(fs.existsSync(stagedGroupPath)).toBe(true);
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('echo copilot');
      expect(fs.statSync(stagedBinaryPath).mode & 0o111).not.toBe(0);

      const stagedHostsPath = hostsVolume?.split(':', 1)[0];
      expect(stagedHostsPath).toBeDefined();
      expect(fs.existsSync(stagedHostsPath || '')).toBe(true);
      expect(fs.readFileSync(stagedHostsPath || '', 'utf8')).toContain('172.17.0.1\thost.docker.internal');

      expect(volumes.some((v: string) => v.includes(`${sharedTmpPrefix}/arc-etc/`))).toBe(false);
      expect(volumes.some((v: string) => v.includes(`${sharedTmpPrefix}/arc-tools/`))).toBe(false);
    } finally {
      mockExecaSync.mockReset();
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
      fs.rmSync(sharedTmpPrefix, { recursive: true, force: true });
    }
  });

  it('should skip non-executable PATH candidates when staging the runner binary', () => {
    const originalPath = process.env.PATH;
    const nonExecutableDir = path.join(getConfig().workDir, 'fake-bin-nonexec');
    const executableDir = path.join(getConfig().workDir, 'fake-bin-exec');
    fs.mkdirSync(nonExecutableDir, { recursive: true });
    fs.mkdirSync(executableDir, { recursive: true });
    fs.writeFileSync(path.join(nonExecutableDir, 'copilot'), '#!/bin/sh\necho wrong\n', { mode: 0o644 });
    fs.writeFileSync(path.join(executableDir, 'copilot'), '#!/bin/sh\necho correct\n', { mode: 0o755 });
    process.env.PATH = `${nonExecutableDir}${path.delimiter}${executableDir}${path.delimiter}${originalPath || ''}`;

    try {
      generateDockerCompose(
        {
          ...getConfig(),
          dockerHostPathPrefix: '/tmp/gh-aw',
          agentCommand: 'copilot --version',
        },
        mockNetworkConfig,
      );

      const stagedBinaryPath = '/tmp/gh-aw/awf-docker-host-stage/bin/copilot';
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('correct');
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
    }
  });

  it('should prefer an explicit command path when staging the runner binary', () => {
    const originalPath = process.env.PATH;
    const fakeBinDir = path.join(getConfig().workDir, 'fake-bin-path');
    const explicitBinDir = path.join(getConfig().workDir, 'explicit-bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(explicitBinDir, { recursive: true });
    fs.writeFileSync(path.join(fakeBinDir, 'copilot'), '#!/bin/sh\necho path\n', { mode: 0o755 });
    const explicitBinaryPath = path.join(explicitBinDir, 'copilot');
    fs.writeFileSync(explicitBinaryPath, '#!/bin/sh\necho explicit\n', { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;

    try {
      generateDockerCompose(
        {
          ...getConfig(),
          dockerHostPathPrefix: '/tmp/gh-aw',
          agentCommand: `${explicitBinaryPath} --version`,
        },
        mockNetworkConfig,
      );

      const stagedBinaryPath = '/tmp/gh-aw/awf-docker-host-stage/bin/copilot';
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('explicit');
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
    }
  });

  it('should leave /etc/passwd and /etc/group unprefixed in shared /tmp staging fallback mode', () => {
    expect(applyHostPathPrefixToVolumes(['/etc/passwd:/host/etc/passwd:ro'], '/tmp/gh-aw'))
      .toEqual(['/etc/passwd:/host/etc/passwd:ro']);
    expect(applyHostPathPrefixToVolumes(['/etc/group:/host/etc/group:ro'], '/tmp/gh-aw'))
      .toEqual(['/etc/group:/host/etc/group:ro']);
  });

  it('should prune stale staged chroot hosts directories under shared /tmp docker-host-path-prefix', () => {
    const stageRoot = '/tmp/gh-aw/awf-docker-host-stage';
    const staleDir = path.join(stageRoot, 'chroot-stale');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'hosts'), '127.0.0.1 localhost\n');
    const staleTime = new Date(Date.now() - (25 * 60 * 60 * 1000));
    fs.utimesSync(staleDir, staleTime, staleTime);
    fs.utimesSync(path.join(staleDir, 'hosts'), staleTime, staleTime);

    const result = generateDockerCompose(
      {
        ...getConfig(),
        dockerHostPathPrefix: '/tmp/gh-aw',
      },
      mockNetworkConfig,
    );
    const volumes = result.services.agent.volumes as string[];

    expect(fs.existsSync(staleDir)).toBe(false);
    expect(
      volumes.some((v: string) => v.startsWith('/tmp/gh-aw/awf-docker-host-stage/chroot-') && v.endsWith(':/host/etc/hosts:ro'))
    ).toBe(true);
  });

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

  it('should handle malformed volume mount without colon as fallback', () => {
    const configWithBadMount = {
      ...getConfig(),
      volumeMounts: ['no-colon-here']
    };
    const result = generateDockerCompose(configWithBadMount, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];
    // Malformed mount should be added as-is (fallback)
    expect(volumes).toContain('no-colon-here');
  });

  it('should reject staged target paths that escape the docker-host staging root', () => {
    const sourceFile = path.join(getConfig().workDir, 'stage-source.txt');
    fs.writeFileSync(sourceFile, 'stage me');

    const stagedPath = stageHostFile(
      { ...getConfig(), dockerHostPathPrefix: '/tmp/gh-aw' },
      sourceFile,
      '../escaped.txt',
    );

    expect(stagedPath).toBeUndefined();
    expect(fs.existsSync('/tmp/gh-aw/escaped.txt')).toBe(false);
  });

  it('should use selective mounts by default', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should NOT include blanket /:/host:rw mount
    expect(volumes).not.toContain('/:/host:rw');

    // Should include system paths (read-only)
    expect(volumes).toContain('/usr:/host/usr:ro');
    expect(volumes).toContain('/bin:/host/bin:ro');
    expect(volumes).toContain('/sbin:/host/sbin:ro');
    expect(volumes).toContain('/lib:/host/lib:ro');
    expect(volumes).toContain('/lib64:/host/lib64:ro');
    expect(volumes).toContain('/opt:/host/opt:ro');

    // Should include special filesystems (read-only)
    // NOTE: /proc is NOT bind-mounted. Instead, a container-scoped procfs is mounted
    // at /host/proc via 'mount -t proc' in entrypoint.sh (requires SYS_ADMIN, which
    // is dropped before user code). This provides dynamic /proc/self/exe resolution.
    expect(volumes).not.toContain('/proc:/host/proc:ro');
    expect(volumes).not.toContain('/proc/self:/host/proc/self:ro');
    expect(volumes).toContain('/sys:/host/sys:ro');
    expect(volumes).toContain('/dev:/host/dev:ro');

    // Should include /etc subdirectories (read-only)
    expect(volumes).toContain('/etc/ssl:/host/etc/ssl:ro');
    expect(volumes).toContain('/etc/ca-certificates:/host/etc/ca-certificates:ro');
    expect(volumes).toContain('/etc/alternatives:/host/etc/alternatives:ro');
    expect(volumes).toContain('/etc/ld.so.cache:/host/etc/ld.so.cache:ro');
    // /etc/hosts is always a custom hosts file in a secure chroot temp dir (for pre-resolved domains)
    const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
    expect(hostsVolume).toBeDefined();
    expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);

    // Should still include essential mounts
    expect(volumes).toContain('/tmp:/tmp:rw');
    expect(volumes.some((v: string) => v.includes('agent-logs'))).toBe(true);
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

  it('should mount Rust toolchain, Node/npm caches, and CLI state directories', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    const homeDir = process.env.HOME || '/root';
    // Rust toolchain directories
    expect(volumes).toContain(`${homeDir}/.cargo:/host${homeDir}/.cargo:rw`);
    expect(volumes).toContain(`${homeDir}/.rustup:/host${homeDir}/.rustup:rw`);
    // npm cache
    expect(volumes).toContain(`${homeDir}/.npm:/host${homeDir}/.npm:rw`);
    // nvm-managed Node.js cache/installations
    expect(volumes).toContain(`${homeDir}/.nvm:/host${homeDir}/.nvm:rw`);
    // CLI state directories
    expect(volumes).toContain(`${homeDir}/.claude:/host${homeDir}/.claude:rw`);
    expect(volumes).toContain(`${homeDir}/.anthropic:/host${homeDir}/.anthropic:rw`);
    // ~/.gemini is NOT mounted when geminiApiKey is absent (fixes suspicious log in Copilot runs)
    expect(volumes).not.toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
    // ~/.copilot is only mounted if it already exists on the host
    if (fs.existsSync(path.join(homeDir, '.copilot'))) {
      expect(volumes).toContain(`${homeDir}/.copilot:/host${homeDir}/.copilot:rw`);
    }
    // session-state and logs are always overlaid from AWF workDir
    expect(volumes).toContain(`${getConfig().workDir}/agent-session-state:/host${homeDir}/.copilot/session-state:rw`);
    expect(volumes).toContain(`${getConfig().workDir}/agent-logs:/host${homeDir}/.copilot/logs:rw`);
  });

  it('should mount ~/.gemini when geminiApiKey is configured', () => {
    const configWithGemini = { ...getConfig(), geminiApiKey: 'AIza-test-gemini-key' };
    const result = generateDockerCompose(configWithGemini, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    const homeDir = process.env.HOME || '/root';
    expect(volumes).toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
  });

  it('should mount container.runnerToolCachePath when it points to a real directory', () => {
    const toolcacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: undefined }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: toolcacheDir,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${toolcacheDir}:/host${toolcacheDir}:ro`);
      });
    } finally {
      fs.rmSync(toolcacheDir, { recursive: true, force: true });
    }
  });

  it('should mount RUNNER_TOOL_CACHE when it is set to a real directory', () => {
    const runnerToolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runner-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });
    } finally {
      fs.rmSync(runnerToolCacheDir, { recursive: true, force: true });
    }
  });

  it('should prefer container.runnerToolCachePath over RUNNER_TOOL_CACHE', () => {
    const configuredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-configured-toolcache-'));
    const runnerToolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runner-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });

      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: configuredDir,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${configuredDir}:/host${configuredDir}:ro`);
        expect(volumes).not.toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });
    } finally {
      fs.rmSync(configuredDir, { recursive: true, force: true });
      fs.rmSync(runnerToolCacheDir, { recursive: true, force: true });
    }
  });

  it('should not mount container.runnerToolCachePath when it is a symlink', () => {
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-target-'));
    const symlinkPath = path.join(os.tmpdir(), `awf-toolcache-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {
      fs.symlinkSync(symlinkTarget, symlinkPath);

      withEnv({ RUNNER_TOOL_CACHE: undefined }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: symlinkPath,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).not.toContain(`${symlinkPath}:/host${symlinkPath}:ro`);
      });
    } finally {
      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
    }
  });

  it('should skip .copilot bind mount when directory does not exist at non-standard HOME path', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-home-'));

    try {
      withEnv({ HOME: fakeHome, SUDO_USER: undefined }, () => {
        const copilotDir = path.join(fakeHome, '.copilot');
        expect(fs.existsSync(copilotDir)).toBe(false);

        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        // Directory should NOT be auto-created (changed in #2114)
        expect(fs.existsSync(copilotDir)).toBe(false);
        // The blanket .copilot mount should be absent
        expect(volumes).not.toContain(`${fakeHome}/.copilot:/host${fakeHome}/.copilot:rw`);
        // Optional self-hosted runner toolcache mount should also be absent
        expect(volumes).not.toContain(`${fakeHome}/work/_tool:/host${fakeHome}/work/_tool:ro`);
        // But session-state and logs overlays are always present
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/session-state:rw`));
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/logs:rw`));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should use sessionStateDir when specified for chroot mounts', () => {
    const configWithSessionDir = { ...getConfig(), sessionStateDir: '/custom/session-state' };
    const result = generateDockerCompose(configWithSessionDir, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];
    const homeDir = process.env.HOME || '/root';
    expect(volumes).toContain(`/custom/session-state:/host${homeDir}/.copilot/session-state:rw`);
    expect(volumes).toContain(`/custom/session-state:${homeDir}/.copilot/session-state:rw`);
  });

  it('should mount /tmp under /host for chroot temp scripts', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // /tmp:/host/tmp:rw is required for entrypoint.sh to write command scripts
    expect(volumes).toContain('/tmp:/host/tmp:rw');
  });

  it('should mount /etc/passwd and /etc/group for user lookup in chroot mode', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // These are needed for getent/user lookup inside chroot
    expect(volumes).toContain('/etc/passwd:/host/etc/passwd:ro');
    expect(volumes).toContain('/etc/group:/host/etc/group:ro');
    expect(volumes).toContain('/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro');
  });

  it('should mount read-only chroot-hosts when enableHostAccess is true', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: true
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should mount a read-only copy of /etc/hosts with host.docker.internal pre-injected
    const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
    expect(hostsVolume).toBeDefined();
    expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
  });

  it('should inject host.docker.internal into chroot-hosts file', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: true
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');
    // Docker bridge gateway resolution may succeed or fail in test env,
    // but the file should exist with at least localhost
    expect(content).toContain('localhost');
  });

  it('should mount custom chroot-hosts even without enableHostAccess', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: false
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should mount a custom hosts file in a secure chroot temp dir (for pre-resolved domains)
    const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
    expect(hostsVolume).toBeDefined();
    expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
  });

  it('should pre-resolve allowed domains into chroot-hosts file', () => {
    // Mock getent to return a resolved IP for a test domain
    mockExecaSync.mockImplementation((...args: any[]) => {
      if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
        const domain = args[1][1];
        if (domain === 'github.com') {
          return { stdout: '140.82.121.4      github.com', stderr: '', exitCode: 0 };
        }
        if (domain === 'npmjs.org') {
          return { stdout: '104.16.22.35      npmjs.org', stderr: '', exitCode: 0 };
        }
        throw new Error('Resolution failed');
      }
      // For docker network inspect (host.docker.internal)
      throw new Error('Not found');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['github.com', 'npmjs.org', '*.wildcard.com'],
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Should contain pre-resolved domains
    expect(content).toContain('140.82.121.4\tgithub.com');
    expect(content).toContain('104.16.22.35\tnpmjs.org');
    // Should NOT contain wildcard domains (can't be resolved)
    expect(content).not.toContain('wildcard.com');

    // Reset mock
    mockExecaSync.mockReset();
  });

  it('should skip domains that fail to resolve during pre-resolution', () => {
    // Mock getent to fail for all domains
    mockExecaSync.mockImplementation(() => {
      throw new Error('Resolution failed');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['unreachable.tailnet.example'],
    };
    // Should not throw even if resolution fails
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Should still have the base hosts content (localhost)
    expect(content).toContain('localhost');
    // Should NOT contain the unresolvable domain
    expect(content).not.toContain('unreachable.tailnet.example');

    // Reset mock
    mockExecaSync.mockReset();
  });

  it('should not add duplicate entries for domains already in /etc/hosts', () => {
    // Mock getent to return a resolved IP
    mockExecaSync.mockImplementation((...args: any[]) => {
      if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
        return { stdout: '127.0.0.1      localhost', stderr: '', exitCode: 0 };
      }
      throw new Error('Not found');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['localhost'], // localhost is already in /etc/hosts
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Count occurrences of 'localhost' - should only be the original entries, not duplicated
    const localhostMatches = content.match(/localhost/g);
    // /etc/hosts typically has multiple localhost entries (127.0.0.1 and ::1)
    // The key assertion is that getent should NOT have been called for localhost
    // since it's already in the hosts file
    expect(localhostMatches).toBeDefined();

    // Reset mock
    mockExecaSync.mockReset();
  });

});
