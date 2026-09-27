import { generateDockerCompose } from './compose-generator';
import { getRealUserHome } from './host-identity';
import { logger } from './logger';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mocks must remain per-file because jest.mock() is hoisted before imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host-gateway resolution (runs execa.sync against Docker, which we don't want in unit tests)
const mockResolveDockerHostGateway = jest.fn();
jest.mock('./services/host-gateway', () => ({
  resolveDockerHostGateway: (...args: any[]) => mockResolveDockerHostGateway(...args),
}));

let mockConfig: WrapperConfig;

beforeEach(() => {
  mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
});

afterEach(() => {
  fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
});

describe('generateDockerCompose: host-gateway IP passthrough (AWF_HOST_GATEWAY_IP)', () => {
  afterEach(() => {
    mockResolveDockerHostGateway.mockReset();
  });

  it('should pass AWF_HOST_GATEWAY_IP to iptables-init when enableHostAccess is true', () => {
    mockResolveDockerHostGateway.mockReturnValue('192.168.1.100');
    const config = { ...mockConfig, enableHostAccess: true };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

    expect(mockResolveDockerHostGateway).toHaveBeenCalled();
    expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('192.168.1.100');
  });

  it('should set AWF_HOST_GATEWAY_IP to empty when enableHostAccess is false', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

    expect(mockResolveDockerHostGateway).not.toHaveBeenCalled();
    expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('');
  });

  it('should set AWF_HOST_GATEWAY_IP to empty when detection fails', () => {
    mockResolveDockerHostGateway.mockReturnValue(undefined);
    const config = { ...mockConfig, enableHostAccess: true };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const initEnv = result.services['iptables-init']?.environment as Record<string, string>;

    expect(initEnv.AWF_HOST_GATEWAY_IP).toBe('');
  });
});

describe('generateDockerCompose: sysroot-stage service (runner.topology = arc-dind)', () => {
  it('adds sysroot-stage service when runnerTopology is arc-dind', () => {
    const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services['sysroot-stage']).toBeDefined();
    expect(result.services['sysroot-stage'].container_name).toBe('awf-sysroot-stage');
    expect(result.services['sysroot-stage'].image).toBe(
      'ghcr.io/github/gh-aw-firewall/build-tools:latest',
    );
  });

  it('does not add sysroot-stage when runnerTopology is not set', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    expect(result.services['sysroot-stage']).toBeUndefined();
  });

  it('does not add sysroot-stage when runnerTopology is standard', () => {
    const config = { ...mockConfig, runnerTopology: 'standard' as const };
    const result = generateDockerCompose(config, mockNetworkConfig);
    expect(result.services['sysroot-stage']).toBeUndefined();
  });

  it('agent depends_on sysroot-stage with service_completed_successfully', () => {
    const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent.depends_on).toMatchObject({
      'sysroot-stage': { condition: 'service_completed_successfully' },
    });
  });

  it('declares sysroot named volume', () => {
    const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.volumes).toBeDefined();
    expect(result.volumes!.sysroot).toEqual({});
  });

  it('adds sysroot:/host:rw to agent volumes', () => {
    const config = { ...mockConfig, runnerTopology: 'arc-dind' as const };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services.agent.volumes).toContain('sysroot:/host:rw');
  });

  it('does not retain base-system bind mounts that shadow sysroot', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      dockerHostPathPrefix: '/daemon-root',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).not.toContain('/usr:/host/usr:ro');
    expect(volumes).not.toContain('/bin:/host/bin:ro');
    expect(volumes).not.toContain('/lib:/host/lib:ro');
    expect(volumes).not.toContain('/lib64:/host/lib64:ro');
    expect(volumes).not.toContain('/opt:/host/opt:ro');
    expect(volumes).toContain('/sys:/host/sys:ro');
    expect(volumes).toContain('/dev:/host/dev:ro');
    expect(volumes.some(v => v.includes(':/host/usr:ro'))).toBe(false);
    expect(volumes.some(v => v.includes(':/host/bin:ro'))).toBe(false);
    expect(volumes.some(v => v.includes(':/host/sbin:ro'))).toBe(false);
    expect(volumes.some(v => v.includes(':/host/lib:ro'))).toBe(false);
    expect(volumes.some(v => v.includes(':/host/lib64:ro'))).toBe(false);
    expect(volumes.some(v => v.includes(':/host/opt:ro'))).toBe(false);
    expect(volumes.filter(v => v.endsWith(':/host/sys:ro'))).toEqual(['/sys:/host/sys:ro']);
    expect(volumes.filter(v => v.endsWith(':/host/dev:ro'))).toEqual(['/dev:/host/dev:ro']);
  });

  it('does not declare sysroot volume when topology is standard', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    expect(result.volumes).toBeUndefined();
  });

  it('uses custom sysrootImage when configured', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      sysrootImage: 'ghcr.io/my-org/custom:v1',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services['sysroot-stage'].image).toBe('ghcr.io/my-org/custom:v1');
  });

  it('uses imageTag in default sysroot image', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      imageTag: '0.28.0',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.services['sysroot-stage'].image).toBe(
      'ghcr.io/github/gh-aw-firewall/build-tools:0.28.0',
    );
  });

  it('warns when runnerToolCachePath is under /opt', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      runnerToolCachePath: '/opt/hostedtoolcache',
    };

    generateDockerCompose(config, mockNetworkConfig);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('under /opt (/opt/hostedtoolcache)')
    );
    warnSpy.mockRestore();
  });

  it('does not warn when runnerToolCachePath is on a shared path', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      runnerToolCachePath: '/var/lib/awf/tool-cache',
    };

    generateDockerCompose(config, mockNetworkConfig);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('under /opt'));
    warnSpy.mockRestore();
  });

  it('declares sysroot volume in network-isolation mode', () => {
    const config = {
      ...mockConfig,
      networkIsolation: true,
      runnerTopology: 'arc-dind' as const,
    };
    const result = generateDockerCompose(config, mockNetworkConfig);

    expect(result.volumes).toEqual({ sysroot: {} });
  });

  it('filters out workDir and home dot-directory bind mounts on split-fs', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      workDir: '/tmp/awf-12345',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];
    const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

    // workDir-based mounts should be dropped
    expect(volumes.some(v => v.startsWith('/tmp/awf-12345'))).toBe(false);

    // Home dot-directory mounts should be dropped, but workspace mounts under home should remain.
    const effectiveHomeForFilter = getRealUserHome();
    const homeTargets = volumes
      .filter(v => {
        const target = v.split(':')[1];
        return target.startsWith(`/host${effectiveHomeForFilter}`) && !v.startsWith('/dev/null');
      })
      .map(v => v.split(':')[1]);

    expect(homeTargets).toContain(`/host${workspaceDir}`);
    expect(homeTargets.some(target => target.startsWith(`/host${effectiveHomeForFilter}/.`))).toBe(false);

    // An explicitly supplied home-root mount (including trailing slash source)
    // survives the filter: the caller vouches for its daemon visibility, and a
    // writable /host$HOME is required by the credential overlays and entrypoint.
    const effectiveHome = getRealUserHome();
    const configWithHomeRootMount = {
      ...config,
      volumeMounts: [`${effectiveHome}/:/host${effectiveHome}:rw`],
    };
    const resultWithHomeRootMount = generateDockerCompose(configWithHomeRootMount, mockNetworkConfig);
    const homeRootMounts = (resultWithHomeRootMount.services.agent.volumes as string[]).filter(v => {
      const target = v.split(':')[1];
      return target === `/host${effectiveHome}` || target === `/host${effectiveHome}/`;
    });
    expect(homeRootMounts).toEqual([`${effectiveHome}/:/host${effectiveHome}:rw`]);

    // The chroot-home volume sourced from workDir is still dropped.
    expect(
      (resultWithHomeRootMount.services.agent.volumes as string[]).some(v =>
        v.startsWith('/tmp/awf-12345-chroot-home'),
      ),
    ).toBe(false);

    // Credential overlays under /host$HOME are kept when a writable home survives.
    expect(
      (resultWithHomeRootMount.services.agent.volumes as string[]).some(
        v => v.startsWith('/dev/null:') && v.split(':')[1].startsWith(`/host${effectiveHome}/`),
      ),
    ).toBe(true);

    // Without such a mount, those overlays are skipped (no writable parent exists).
    expect(
      volumes.some(
        v => v.startsWith('/dev/null:') && v.split(':')[1].startsWith(`/host${effectiveHome}/`),
      ),
    ).toBe(false);

    // Should still have /tmp:/tmp, /sys, /dev, sysroot volume
    expect(volumes).toContain('/tmp:/tmp:rw');
    expect(volumes).toContain('/sys:/host/sys:ro');
    expect(volumes).toContain('/dev:/host/dev:ro');
    expect(volumes).toContain('sysroot:/host:rw');
  });

  it('drops the workDir-adjacent chroot-home bind mount on split-fs', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      workDir: '/tmp/awf-12345',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    // The empty-home mount is sourced from `${workDir}-chroot-home`, a sibling
    // of workDir under the runner's /tmp that the DinD daemon cannot see.
    expect(volumes.some(v => v.split(':')[0] === '/tmp/awf-12345-chroot-home')).toBe(false);
    expect(volumes.some(v => v.split(':')[0].startsWith('/tmp/awf-12345'))).toBe(false);
  });

  // Regression test for gh-aw-firewall#7994: on real ARC/DinD runners
  // `--docker-host-path-prefix` is set alongside `runnerTopology: arc-dind`.
  // `buildAgentVolumes` applies that prefix before this split-fs filter
  // ever sees the volumes, so a chroot-home/`$HOME` dot-dir mount that
  // should have been dropped as workDir/home-derived instead survived
  // pointing at a daemon-invisible path — and Docker failed creating the
  // `/dev/null` -> `.npmrc` mountpoint with a read-only-filesystem error.
  it('drops the prefixed chroot-home volume and credential overlays when docker-host-path-prefix is set', () => {
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      workDir: '/tmp/awf-12345',
      dockerHostPathPrefix: '/host',
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];
    const effectiveHome = getRealUserHome();

    // No mount sourced from the (prefixed) workDir or its chroot-home
    // sibling should survive — the daemon cannot resolve either path.
    expect(volumes.some(v => v.split(':')[0].includes('/tmp/awf-12345'))).toBe(false);

    // Without an explicit writable `--mount` for the home root, the
    // credential-hiding overlays for these exact files (the ones named in
    // the issue) must be dropped rather than emitted against a mountpoint
    // Docker cannot create.
    for (const credentialFile of ['.npmrc', '.docker/config.json', '.composer/auth.json']) {
      expect(volumes).not.toContain(`/dev/null:/host${effectiveHome}/${credentialFile}:ro`);
    }

    // The direct (non-chroot) overlays on the container's own rootfs are
    // unaffected and still mask the same files.
    for (const credentialFile of ['.npmrc', '.docker/config.json', '.composer/auth.json']) {
      expect(volumes).toContain(`/dev/null:${effectiveHome}/${credentialFile}:ro`);
    }
  });

  it('keeps prefixed credential overlays mountable when an explicit writable home mount is supplied', () => {
    const effectiveHome = getRealUserHome();
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      workDir: '/tmp/awf-12345',
      dockerHostPathPrefix: '/host',
      volumeMounts: [`${effectiveHome}/:/host${effectiveHome}:rw`],
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    // The explicitly supplied home-root mount survives, prefixed exactly
    // once, and is still writable — so runc can create the credential
    // mountpoints nested inside it.
    expect(volumes).toContain(`/host${effectiveHome}/:/host${effectiveHome}:rw`);

    for (const credentialFile of ['.npmrc', '.docker/config.json', '.composer/auth.json']) {
      expect(volumes).toContain(`/dev/null:/host${effectiveHome}/${credentialFile}:ro`);
    }
  });
});
