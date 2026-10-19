import * as fs from 'fs';
import type { WrapperConfig } from '../types';
import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import { GEMINI_CLI_SYSTEM_SETTINGS_PATH, getGeminiSystemSettingsSourcePath } from './credentials/gemini-cli-settings';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it.each([undefined, '/host', '/tmp/gh-aw'])(
    'mounts the Gemini auth pin read-only under /etc with prefix %s',
    (dockerHostPathPrefix) => {
      const rootSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
      try {
        const config = {
          ...getConfig(), enableApiProxy: true, geminiApiKey: 'fake-key', dockerHostPathPrefix,
        };
        const volumes = generateDockerCompose(config, mockNetworkConfig).services.agent.volumes as string[];
        const source = getGeminiSystemSettingsSourcePath(config.workDir);
        const translated = dockerHostPathPrefix ? `${dockerHostPathPrefix}${source}` : source;
        expect(volumes).toContain(`${translated}:/host${GEMINI_CLI_SYSTEM_SETTINGS_PATH}:ro`);
        expect(volumes.some((volume) => volume.includes(':/host/home/') && volume.includes('settings.json'))).toBe(false);
      } finally {
        rootSpy.mockRestore();
      }
    },
  );

  it('uses privileged entrypoint staging instead of a host bind for non-root Compose', () => {
    const nonRootSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
    try {
      const compose = generateDockerCompose({
        ...getConfig(), enableApiProxy: true, geminiApiKey: 'fake-key', networkIsolation: true,
      }, { ...mockNetworkConfig, proxyIp: '172.30.0.30' });
      const volumes = compose.services.agent.volumes as string[];
      expect(volumes.some((volume) => volume.includes(`:/host${GEMINI_CLI_SYSTEM_SETTINGS_PATH}:`))).toBe(false);
      expect(compose.services.agent.environment?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      expect(compose.services.agent.environment?.AWF_GEMINI_SYSTEM_SETTINGS_FALLBACK).toBe('1');
    } finally {
      nonRootSpy.mockRestore();
    }
  });

  it.each<Partial<WrapperConfig>>([
    { enableApiProxy: false, geminiApiKey: 'fake-key' },
    { enableApiProxy: true },
    { enableApiProxy: true, geminiApiKey: 'fake-key', additionalEnv: { GOOGLE_GENAI_USE_VERTEXAI: 'true' } },
    { enableApiProxy: true, geminiApiKey: 'fake-key', additionalEnv: { GOOGLE_GENAI_USE_GCA: 'true' } },
  ])('omits the system settings mount when pinning is disabled: %j', (overrides) => {
    const volumes = generateDockerCompose({ ...getConfig(), ...overrides }, mockNetworkConfig)
      .services.agent.volumes as string[];
    expect(volumes.some((volume) => volume.includes(`:/host${GEMINI_CLI_SYSTEM_SETTINGS_PATH}:`))).toBe(false);
  });

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

  it('should enforce filesystem.allowWrite with read-only parents and writable overlays', () => {
    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
    const writablePath = `${workspaceDir}/src`;
    const result = generateDockerCompose(
      {
        ...getConfig(),
        filesystemAllowWrite: [writablePath],
      },
      mockNetworkConfig,
    );
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain(`${workspaceDir}:${workspaceDir}:ro`);
    expect(volumes).toContain(`${workspaceDir}:/host${workspaceDir}:ro`);
    expect(volumes).toContain(`${writablePath}:${writablePath}:rw`);
    expect(volumes).toContain(`${writablePath}:/host${writablePath}:rw`);
    expect(volumes).toContain('/tmp:/tmp:ro');
    expect(volumes).toContain('/tmp:/host/tmp:ro');
    expect(volumes).toContain(`${getConfig().workDir}/init-signal:/run/awf-init:rw`);
    // Legacy path stays exposed read-only so a newer CLI still works with an
    // older pinned agent image, and it must not become a writable hole in the
    // narrowed /tmp tree.
    expect(volumes).toContain(`${getConfig().workDir}/init-signal:/tmp/awf-init:ro`);
    expect(volumes).not.toContain(`${getConfig().workDir}/init-signal:/tmp/awf-init:rw`);
    expect(volumes.some((volume) => volume.includes('/.copilot/logs:rw'))).toBe(true);
  });

  it('should apply dockerHostPathPrefix to bind-mount source paths', () => {
    const configWithPrefix = {
      ...getConfig(),
      dockerHostPathPrefix: '/daemon-root',
      chrootBinariesSourcePath: '/tmp/gh-aw/runner-bin',
      volumeMounts: ['/workspace:/workspace:ro'],
    };
    const result = generateDockerCompose(configWithPrefix, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain('/daemon-root/tmp:/tmp:rw');
    expect(volumes).toContain('/daemon-root/usr:/host/usr:ro');
    expect(volumes).toContain('/daemon-root/tmp/gh-aw/runner-bin:/host/tmp/awf-runner-bin:ro');
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

  it('should enforce allowWrite for ARC/DinD custom mount descendants', () => {
    const source = process.cwd();
    const result = generateDockerCompose(
      {
        ...getConfig(),
        dockerHostPathPrefix: '/daemon-root',
        chrootBinariesSourcePath: '/tmp/gh-aw/runner-bin',
        volumeMounts: [`${source}:/data:rw`],
        filesystemAllowWrite: ['/data/src'],
      },
      mockNetworkConfig,
    );
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain(`/daemon-root${source}:/host/data:ro`);
    expect(volumes).toContain(`/daemon-root${source}/src:/host/data/src:rw`);
  });

  it('should translate the safeoutputs mount when its source equals dockerHostPathPrefix', () => {
    const safeOutputsPath = '/tmp/gh-aw';
    const result = generateDockerCompose(
      {
        ...getConfig(),
        dockerHostPathPrefix: safeOutputsPath,
        volumeMounts: [`${safeOutputsPath}:${safeOutputsPath}:rw`],
      },
      mockNetworkConfig,
    );
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain('/tmp/gh-aw/tmp/gh-aw:/host/tmp/gh-aw:rw');
    expect(volumes).not.toContain('/tmp/gh-aw:/host/tmp/gh-aw:rw');
  });

  it('should mount chroot binaries source path at /host/tmp/awf-runner-bin', () => {
    const configWithBinariesOverlay = {
      ...getConfig(),
      chrootBinariesSourcePath: '/tmp/gh-aw/runner-bin',
    };
    const result = generateDockerCompose(configWithBinariesOverlay, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain('/usr:/host/usr:ro');
    // Binaries overlay uses /host/tmp/awf-runner-bin (not /host/usr/local/bin) so that
    // Docker can always create the mount-point directory inside the writable /host/tmp.
    expect(volumes).toContain('/tmp/gh-aw/runner-bin:/host/tmp/awf-runner-bin:ro');
    expect(volumes).not.toContain('/tmp/gh-aw/runner-bin:/host/usr/local/bin:ro');
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

  it('should mount binaries overlay at /host/tmp/awf-runner-bin when binariesSourcePath equals dockerHostPathPrefix', () => {
    // Regression test for ARC/DinD collision: when binariesSourcePath equals
    // dockerHostPathPrefix (both /tmp/gh-aw), the old target /host/usr/local/bin
    // could not be created by Docker because /host/usr was already mounted read-only.
    // The new target /host/tmp/awf-runner-bin sits under the writable /host/tmp mount
    // so Docker can always create the subdirectory mount-point.
    const sharedPrefix = '/tmp/gh-aw';
    const configCollision = {
      ...getConfig(),
      dockerHostPathPrefix: sharedPrefix,
      chrootBinariesSourcePath: sharedPrefix, // same value as prefix — the problematic case
    };
    const result = generateDockerCompose(configCollision, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    // /host/usr is mounted read-only from the staged prefix
    expect(volumes).toContain(`${sharedPrefix}/usr:/host/usr:ro`);

    // Binaries overlay is at /host/tmp/awf-runner-bin — NOT nested under /host/usr:ro
    // The source equals the prefix so applyHostPathPrefixToVolumes leaves it un-prefixed
    expect(volumes).toContain(`${sharedPrefix}:/host/tmp/awf-runner-bin:ro`);

    // Must NOT produce the old colliding mount that Docker could not set up
    expect(volumes).not.toContain(`${sharedPrefix}:/host/usr/local/bin:ro`);
    expect(volumes.some((v: string) => v.includes('/host/usr/local/bin'))).toBe(false);
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
    if (fs.existsSync('/etc/pki/ca-trust/extracted')) {
      expect(volumes).toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
    } else {
      expect(volumes).not.toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
    }
    if (fs.existsSync('/etc/pki/tls/certs')) {
      expect(volumes).toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
    } else {
      expect(volumes).not.toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
    }
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
});
