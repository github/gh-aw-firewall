import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateDockerCompose } from '../compose-generator';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import type { WrapperConfig } from '../types';
import {
  buildGeminiSettingsService,
  GEMINI_SETTINGS_MOUNT,
  GEMINI_SETTINGS_SERVICE,
  GEMINI_SETTINGS_VOLUME,
} from './gemini-settings-service';
import { buildGeminiSystemSettingsContent, getGeminiSystemSettingsPath } from './credentials/gemini-cli-settings';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('Gemini system settings contract', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gemini-settings-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function compose(
    overrides: Partial<WrapperConfig> = {},
    prepareNestedMountpoints: NonNullable<
      NonNullable<Parameters<typeof generateDockerCompose>[4]>['prepareNestedMountpoints']
    > = () => [],
  ) {
    return generateDockerCompose({
      ...baseConfig,
      workDir,
      enableApiProxy: true,
      geminiApiKey: 'test-only-real-key',
      ...overrides,
    }, { ...mockNetworkConfig, proxyIp: '172.30.0.30' }, undefined, undefined, {
      effectiveHome: '/home/runner',
      pathExists: () => false,
      prepareNestedMountpoints,
    });
  }

  it.each<Partial<WrapperConfig>>([
    {},
    { containerRuntime: 'gvisor' },
    { dockerHostPathPrefix: '/daemon' },
    { runnerTopology: 'arc-dind', dockerHostPathPrefix: '/daemon' },
    { filesystemAllowWrite: [] },
  ])('stages root-owned policy outside HOME and mounts it read-only: %j', (overrides) => {
    const result = compose(overrides);
    const agent = result.services.agent;
    const initializer = result.services[GEMINI_SETTINGS_SERVICE];

    expect(agent.environment).toMatchObject({
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: getGeminiSystemSettingsPath(),
      GOOGLE_GEMINI_BASE_URL: 'http://172.30.0.30:10003',
      GEMINI_API_BASE_URL: 'http://172.30.0.30:10003',
      GEMINI_API_KEY: 'gemini-api-key-placeholder-for-credential-isolation',
    });
    expect(Object.values(agent.environment ?? {})).not.toContain('test-only-real-key');
    expect(agent.volumes).toContain(GEMINI_SETTINGS_MOUNT);
    expect(agent.depends_on).toMatchObject({
      [GEMINI_SETTINGS_SERVICE]: { condition: 'service_completed_successfully' },
    });
    expect(initializer).toMatchObject({
      image: agent.image,
      user: '0:0',
      network_mode: 'none',
      read_only: true,
      volumes: [`${GEMINI_SETTINGS_VOLUME}:/settings:rw`],
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
    });
    expect(initializer.environment).toBeUndefined();
    expect(initializer.command?.[0]).toContain(buildGeminiSystemSettingsContent());
    expect(initializer.command?.[0]).not.toContain('test-only-real-key');
    expect(result.volumes).toHaveProperty(GEMINI_SETTINGS_VOLUME);
    if (overrides.runnerTopology === 'arc-dind') {
      expect(result.volumes).toHaveProperty('sysroot');
      expect(agent.volumes).toContain('sysroot:/host:rw');
    }
  });

  it('leaves the ordinary chroot home writable', () => {
    expect(compose().services.agent.volumes).toContain(`${workDir}-chroot-home:/host/home/runner:rw`);
  });

  it('plans the named settings mount beneath a read-only /etc bind', () => {
    const prepareNestedMountpoints = jest.fn(() => []);
    const result = compose({ volumeMounts: ['/etc:/etc:ro'] }, prepareNestedMountpoints);

    expect(result.services.agent.volumes).toContain(GEMINI_SETTINGS_MOUNT);
    expect(prepareNestedMountpoints).toHaveBeenCalledWith(
      expect.arrayContaining(['/etc:/host/etc:ro', GEMINI_SETTINGS_MOUNT]),
      expect.any(Number),
      expect.any(Number),
      expect.any(Function),
      {
        directoryVolumeSources: [GEMINI_SETTINGS_VOLUME],
        rootOwnedTargets: ['/host/etc/awf/gemini-cli'],
      },
    );
  });

  it('uses the local agent build when requested instead of pulling another image', () => {
    const result = compose({ buildLocal: true });
    expect(result.services[GEMINI_SETTINGS_SERVICE].build).toEqual(result.services.agent.build);
    expect(result.services[GEMINI_SETTINGS_SERVICE].image).toBeUndefined();
  });

  it('supports GCP OIDC without staging credentials', () => {
    const result = compose({
      geminiApiKey: undefined,
      authType: 'github-oidc',
      authProvider: 'gcp',
      authGcpWorkloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });
    expect(result.services[GEMINI_SETTINGS_SERVICE]).toBeDefined();
    expect(result.services.agent.environment?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(getGeminiSystemSettingsPath());
  });

  it.each<Partial<WrapperConfig>>([
    { enableApiProxy: false },
    { geminiApiKey: undefined },
    { additionalEnv: { GOOGLE_GENAI_USE_VERTEXAI: 'true' } },
    { additionalEnv: { GOOGLE_GENAI_USE_GCA: 'true' } },
    { containerRuntime: 'sbx' },
    { containerRuntime: 'cloud-hypervisor' },
  ])('does not stage or select system settings outside the supported auth/runtime gate: %j', (overrides) => {
    const result = compose(overrides);
    expect(result.services[GEMINI_SETTINGS_SERVICE]).toBeUndefined();
    expect(result.volumes?.[GEMINI_SETTINGS_VOLUME]).toBeUndefined();
    expect(result.services.agent?.volumes ?? []).not.toContain(GEMINI_SETTINGS_MOUNT);
    expect(result.services.agent?.environment?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });

  it('rejects missing image configuration', () => {
    expect(() => buildGeminiSettingsService({})).toThrow('requires the agent image or build');
  });

  it('writes only the non-secret auth selection', () => {
    expect(JSON.parse(buildGeminiSystemSettingsContent())).toEqual({
      security: { auth: { selectedType: 'gemini-api-key' } },
    });
  });
});
