import { generateDockerCompose } from './compose-generator';
import { getRealUserHome } from './host-identity';
import * as hostIdentity from './host-identity';
import { spawnSync } from 'child_process';
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
  jest.restoreAllMocks();
  fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
});

describe('generateDockerCompose: ARC/DinD shared-file ownership', () => {
  function sharedWriters() {
    return generateDockerCompose({
      ...mockConfig,
      runnerTopology: 'arc-dind',
      dockerHostPathPrefix: '/tmp',
      enableApiProxy: true,
      difcProxyHost: 'host.docker.internal:18443',
    }, {
      ...mockNetworkConfig,
      proxyIp: '172.30.0.30',
      cliProxyIp: '172.30.0.50',
    }).services;
  }

  it('uses the runner identity rather than image-defined users for shared log writers', () => {
    jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue('12345');
    jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue('23456');

    const services = sharedWriters();
    for (const name of ['api-proxy', 'cli-proxy']) {
      expect(services[name].user).toBe('12345:23456');
    }
  });

  const testRunnerOwnership = process.platform === 'linux'
    && (process.getuid?.() ?? 0) >= 1000 && (process.getgid?.() ?? 0) > 0
    ? it : it.skip;
  testRunnerOwnership('creates runner-owned files that the runner can rewrite and atomically replace', () => {
    const services = sharedWriters();
    for (const name of ['api-proxy', 'cli-proxy']) {
      const [uid, gid] = (services[name].user as string).split(':').map(Number);
      const file = path.join(mockConfig.workDir, `${name}.jsonl`);
      const child = spawnSync(process.execPath, ['-e',
        'require("fs").writeFileSync(process.argv[1], "original\\n", {mode: 0o600})', file,
      ], { uid, gid, encoding: 'utf8', env: {}, timeout: 10000 });

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(fs.statSync(file)).toMatchObject({ uid: process.getuid!(), gid: process.getgid!() });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      fs.writeFileSync(file, 'rewritten\n');
      fs.writeFileSync(`${file}.tmp`, 'replaced\n', { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      expect(fs.readFileSync(file, 'utf8')).toBe('replaced\n');
    }
  });
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

    // A writable home keeps masks only for credentials that already exist.
    for (const credentialFile of ['.npmrc', '.docker/config.json', '.composer/auth.json']) {
      expect(
        (resultWithHomeRootMount.services.agent.volumes as string[]).includes(
          `/dev/null:/host${effectiveHome}/${credentialFile}:ro`,
        ),
      ).toBe(fs.existsSync(path.join(effectiveHome, credentialFile)));
    }

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

  it('keeps prefixed masks only for existing credentials behind an explicit writable home mount', () => {
    const effectiveHome = getRealUserHome();
    const homeSource = path.join(mockConfig.workDir, 'home');
    fs.mkdirSync(homeSource);
    fs.writeFileSync(path.join(homeSource, '.npmrc'), '');
    const config = {
      ...mockConfig,
      runnerTopology: 'arc-dind' as const,
      workDir: '/tmp/awf-12345',
      dockerHostPathPrefix: '/host',
      volumeMounts: [`${homeSource}/:/host${effectiveHome}:rw`],
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    // The home-root mount survives, prefixed exactly once. Only the existing
    // credential needs a mask; missing targets must not become host placeholders.
    expect(volumes).toContain(`/host${homeSource}/:/host${effectiveHome}:rw`);
    expect(volumes).toContain(`/dev/null:/host${effectiveHome}/.npmrc:ro`);

    for (const credentialFile of ['.docker/config.json', '.composer/auth.json']) {
      expect(volumes).not.toContain(`/dev/null:/host${effectiveHome}/${credentialFile}:ro`);
    }
    expect(fs.readdirSync(homeSource)).toEqual(['.npmrc']);
  });

  it('keeps a GitHub credential mask from an explicit home mount after filtering the automatic .config mount', () => {
    const effectiveHome = path.join(mockConfig.workDir, 'effective-home');
    const homeSource = path.join(mockConfig.workDir, 'home-source');
    fs.mkdirSync(path.join(homeSource, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(homeSource, '.config/gh/hosts.yml'), 'DUMMY_SECRET_VALUE');
    fs.mkdirSync(effectiveHome);
    const config = {
      ...mockConfig,
      workDir: '/tmp/awf-12345',
      runnerTopology: 'arc-dind' as const,
      dockerHostPathPrefix: '/host',
      volumeMounts: [`${homeSource}/:/host${effectiveHome}:rw`],
    };

    const result = generateDockerCompose(config, mockNetworkConfig, undefined, undefined, { effectiveHome });
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).toContain(`/dev/null:/host${effectiveHome}/.config/gh/hosts.yml:ro`);
  });

  it('drops a GitHub credential mask when only the filtered automatic .config mount contains it', () => {
    const effectiveHome = path.join(mockConfig.workDir, 'effective-home');
    const homeSource = path.join(mockConfig.workDir, 'home-source');
    fs.mkdirSync(path.join(effectiveHome, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(effectiveHome, '.config/gh/hosts.yml'), 'DUMMY_SECRET_VALUE');
    fs.mkdirSync(homeSource);
    const config = {
      ...mockConfig,
      workDir: '/tmp/awf-12345',
      runnerTopology: 'arc-dind' as const,
      dockerHostPathPrefix: '/host',
      volumeMounts: [`${homeSource}/:/host${effectiveHome}:rw`],
    };

    const result = generateDockerCompose(config, mockNetworkConfig, undefined, undefined, { effectiveHome });
    const volumes = result.services.agent.volumes as string[];

    expect(volumes).not.toContain(`/dev/null:/host${effectiveHome}/.config/gh/hosts.yml:ro`);
    expect(fs.readdirSync(homeSource)).toEqual([]);
  });
});
