import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

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
