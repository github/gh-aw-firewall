import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSysrootStageService, isSysrootEnabled, resolveSysrootImage } from './sysroot-service';
import { parseImageTag } from '../image-tag';
import { WrapperConfig } from '../types';
import { GEMINI_CLI_SYSTEM_SETTINGS_PATH, buildGeminiSystemSettingsContent } from './credentials/gemini-cli-settings';

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

  it('includes sha256 digest in resolved image when provided in imageTag', () => {
    const digest = 'sha256:' + 'f'.repeat(64);
    const config = makeConfig({
      runnerTopology: 'arc-dind',
      imageTag: `v0.28.0,build-tools=${digest}`,
    });
    expect(resolveSysrootImage(config)).toBe(
      `ghcr.io/github/gh-aw-firewall/build-tools:v0.28.0@${digest}`,
    );
  });
});

describe('buildSysrootStageService', () => {
  it('writes the protected Gemini settings into the sysroot even after an idempotent copy', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind', enableApiProxy: true, geminiApiKey: 'fake-key' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    const command = service.command[0] as string;
    expect(command).toContain('if [ -L /sysroot/etc ] || [ -L /sysroot/etc/awf ]');
    expect(command).toContain('exit 1; fi; mkdir -p /sysroot/etc/awf/gemini-cli');
    expect(command).toContain(`> /sysroot${GEMINI_CLI_SYSTEM_SETTINGS_PATH}`);
    expect(command).toContain(Buffer.from(buildGeminiSystemSettingsContent()).toString('base64'));
    expect(command).toContain(`chmod 644 /sysroot${GEMINI_CLI_SYSTEM_SETTINGS_PATH}`);
    expect(command).not.toContain('fake-key');
  });

  it.each(['etc', 'etc/awf', 'etc/awf/gemini-cli', 'etc/awf/gemini-cli/settings.json'])(
    'refuses a symlink at %s before changing its target',
    (ancestor) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gemini-sysroot-'));
      try {
        const sysroot = path.join(root, 'sysroot');
        const target = path.join(root, 'target');
        fs.mkdirSync(sysroot);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(sysroot, '.awf-sysroot-ready'), '');
        fs.writeFileSync(path.join(target, 'settings.json'), 'unchanged');
        const link = path.join(sysroot, ancestor);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(ancestor.endsWith('.json') ? path.join(target, 'settings.json') : target, link);
        const before = fs.statSync(path.join(target, 'settings.json'));
        const service = buildSysrootStageService({
          config: makeConfig({ runnerTopology: 'arc-dind', enableApiProxy: true, geminiApiKey: 'fake-key' }),
          registry: 'ghcr.io/github/gh-aw-firewall',
          parsedTag: parseImageTag('latest'),
        });
        const command = (service.command[0] as string).replace(/\/sysroot/g, sysroot).replace(/\$\$/g, '$');
        const args = ['-c', command];
        const result = spawnSync(
          process.getuid!() === 0 ? '/bin/sh' : 'sudo',
          process.getuid!() === 0 ? args : ['-n', '/bin/sh', ...args],
          { encoding: 'utf8' },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Refusing symlink');
        expect(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).toBe('unchanged');
        const after = fs.statSync(path.join(target, 'settings.json'));
        expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
        expect(fs.readdirSync(target)).toEqual(['settings.json']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each<Partial<WrapperConfig>>([
    { enableApiProxy: false, geminiApiKey: 'fake-key' },
    { enableApiProxy: true },
    { enableApiProxy: true, geminiApiKey: 'fake-key', additionalEnv: { GOOGLE_GENAI_USE_GCA: 'true' } },
    { enableApiProxy: true, geminiApiKey: 'fake-key', additionalEnv: { GOOGLE_GENAI_USE_VERTEXAI: 'true' } },
  ])('does not write Gemini settings to the sysroot without API-key pinning: %j', (overrides) => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind', ...overrides }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.command[0]).not.toContain(GEMINI_CLI_SYSTEM_SETTINGS_PATH);
  });
  it('generates a service with correct container name', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.container_name).toBe('awf-sysroot-stage');
  });

  it('uses default build-tools image', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('0.28.0'),
    });
    expect(service.image).toBe('ghcr.io/github/gh-aw-firewall/build-tools:0.28.0');
  });

  it('appends sha256 digest when build-tools digest is provided', () => {
    const digest = 'sha256:' + 'e'.repeat(64);
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag(`0.28.0,build-tools=${digest}`),
    });
    expect(service.image).toBe(`ghcr.io/github/gh-aw-firewall/build-tools:0.28.0@${digest}`);
  });

  it('uses explicit sysrootImage when configured', () => {
    const service = buildSysrootStageService({
      config: makeConfig({
        runnerTopology: 'arc-dind',
        sysrootImage: 'ghcr.io/my-org/sysroot:v2',
      }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.image).toBe('ghcr.io/my-org/sysroot:v2');
  });

  it('mounts sysroot named volume', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.volumes).toEqual(['sysroot:/sysroot']);
  });

  it('uses sh entrypoint and cp -a command', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
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
      parsedTag: parseImageTag('latest'),
    });
    expect(service.command[0]).toContain('.awf-sysroot-ready');
  });

  it('escapes $d as $$d for Docker Compose variable interpolation', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    // Docker Compose treats $var as variable interpolation; $$ escapes to literal $
    expect(service.command[0]).toContain('/$$d');
    expect(service.command[0]).not.toMatch(/\/\$d[^$]/);
  });

  it('uses network_mode none (no network needed for copy)', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.network_mode).toBe('none');
  });

  it('copies /lib64 conditionally without masking copy failures', () => {
    const service = buildSysrootStageService({
      config: makeConfig({ runnerTopology: 'arc-dind' }),
      registry: 'ghcr.io/github/gh-aw-firewall',
      parsedTag: parseImageTag('latest'),
    });
    expect(service.command[0]).toContain('if [ -d /lib64 ]; then cp -a /lib64 /sysroot/; fi;');
    expect(service.command[0]).not.toContain('|| true');
  });
});
