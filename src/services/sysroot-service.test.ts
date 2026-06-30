import { buildSysrootStageService, isSysrootEnabled, resolveSysrootImage } from './sysroot-service';
import { WrapperConfig } from '../types';

// Minimal WrapperConfig for testing
function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agentCommand: 'echo test',
    logLevel: 'info',
    keepContainers: false,
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

describe('isSysrootEnabled', () => {
  it('returns false when runnerTopology is not set', () => {
    expect(isSysrootEnabled(makeConfig())).toBe(false);
  });

  it('returns false when runnerTopology is standard', () => {
    expect(isSysrootEnabled(makeConfig({ runnerTopology: 'standard' }))).toBe(false);
  });

  it('returns true when runnerTopology is arc-dind', () => {
    expect(isSysrootEnabled(makeConfig({ runnerTopology: 'arc-dind' }))).toBe(true);
  });
});

describe('resolveSysrootImage', () => {
  it('returns undefined when sysroot is not enabled', () => {
    expect(resolveSysrootImage(makeConfig())).toBeUndefined();
  });

  it('returns default build-tools image when no override', () => {
    const config = makeConfig({ runnerTopology: 'arc-dind' });
    expect(resolveSysrootImage(config)).toBe(
      'ghcr.io/github/gh-aw-firewall/build-tools:latest',
    );
  });

  it('uses custom imageTag in default image', () => {
    const config = makeConfig({ runnerTopology: 'arc-dind', imageTag: 'v0.28.0' });
    expect(resolveSysrootImage(config)).toBe(
      'ghcr.io/github/gh-aw-firewall/build-tools:v0.28.0',
    );
  });

  it('uses custom imageRegistry in default image', () => {
    const config = makeConfig({
      runnerTopology: 'arc-dind',
      imageRegistry: 'my-registry.example.com/awf',
    });
    expect(resolveSysrootImage(config)).toBe(
      'my-registry.example.com/awf/build-tools:latest',
    );
  });

  it('returns explicit sysrootImage when set', () => {
    const config = makeConfig({
      runnerTopology: 'arc-dind',
      sysrootImage: 'ghcr.io/my-org/custom-sysroot:v1',
    });
    expect(resolveSysrootImage(config)).toBe('ghcr.io/my-org/custom-sysroot:v1');
  });
});

describe('buildSysrootStageService', () => {
  it('generates a service with correct container name', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.container_name).toBe('awf-sysroot-stage');
  });

  it('uses default build-tools image', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: '0.28.0',
    });
    expect(service.image).toBe('ghcr.io/github/gh-aw-firewall/build-tools:0.28.0');
  });

  it('uses explicit sysrootImage when configured', () => {
    const service = buildSysrootStageService({
      config: makeConfig({
        runnerTopology: 'arc-dind',
        sysrootImage: 'ghcr.io/my-org/sysroot:v2',
      }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.image).toBe('ghcr.io/my-org/sysroot:v2');
  });

  it('mounts sysroot named volume', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.volumes).toEqual(['sysroot:/sysroot']);
  });

  it('uses sh entrypoint and cp -a command', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.entrypoint).toEqual(['/bin/sh', '-c']);
    expect(service.command).toHaveLength(1);
    expect(service.command[0]).toContain('cp -a');
    expect(service.command[0]).toContain('/sysroot/');
  });

  it('includes sentinel file check for idempotent re-runs', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.command[0]).toContain('.awf-sysroot-ready');
  });

  it('escapes $d as $$d for Docker Compose variable interpolation', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    // Docker Compose treats $var as variable interpolation; $$ escapes to literal $
    expect(service.command[0]).toContain('/$$d');
    expect(service.command[0]).not.toMatch(/\/\$d[^$]/);
  });

  it('uses network_mode none (no network needed for copy)', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.network_mode).toBe('none');
  });

  it('copies /lib64 conditionally without masking copy failures', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });
    expect(service.command[0]).toContain('if [ -d /lib64 ]; then cp -a /lib64 /sysroot/; fi;');
    expect(service.command[0]).not.toContain('|| true');
  });
});
