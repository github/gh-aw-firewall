import './main-action-enclave-mocks.test-utils';
import * as fs from 'fs';
import * as dockerManager from '../docker-manager';
import * as hostIptables from '../host-iptables';
import { logger } from '../logger';
import * as enclaveManager from '../enclave/manager';
import * as enclaveGateway from '../enclave/gateway';
import * as enclaveGithubGateway from '../enclave/github-gateway';
import * as enclaveHostLifecycle from '../enclave/cloud-hypervisor-lifecycle';
import * as externalRuntimeResolver from '../external-runtime-backend-resolver';
import { mainActionFsMocks } from './main-action-fs-mock.test-utils';
import {
  MAIN_ACTION_STUB_CONFIG,
  describeMainAction,
  getMainActionMocks,
  makeEnclaveConfig,
  makeSbxConfig,
  setupMainActionPlatformHarness,
  setupMainActionTestHarness,
  type MainActionTestHarness,
} from './main-action.test-utils';

describe('main-action config builders', () => {
  it('builds fresh sbx fixtures and applies overrides without changing the stub', () => {
    const config = makeSbxConfig({
      containerWorkDir: '/workspace',
      keepContainers: true,
      enableApiProxy: true,
    });
    expect(config).toEqual({
      ...MAIN_ACTION_STUB_CONFIG,
      containerRuntime: 'sbx',
      containerWorkDir: '/workspace',
      keepContainers: true,
      enableApiProxy: true,
    });
    expect(makeSbxConfig()).toEqual({ ...MAIN_ACTION_STUB_CONFIG, containerRuntime: 'sbx' });
    expect(makeSbxConfig()).not.toBe(config);
    expect(MAIN_ACTION_STUB_CONFIG.keepContainers).toBe(false);
    expect(MAIN_ACTION_STUB_CONFIG.containerWorkDir).toBeUndefined();
  });

  it('builds enclave fixtures with independent defaults and executor overrides', () => {
    const config = makeEnclaveConfig({
      script: { enabled: true, timeout: 10 },
      agent: { enabled: true, github: { cli: 'issues-read-v1' } },
    });
    expect(config).toMatchObject({
      ...MAIN_ACTION_STUB_CONFIG,
      enclaves: {
        enabled: true,
        privateRepos: [],
        executors: {
          script: { enabled: true, runtime: 'docker', network: 'none', timeout: 10 },
          agent: { enabled: true, network: 'api-proxy-only', github: { cli: 'issues-read-v1' } },
        },
      },
    });
    const next = makeEnclaveConfig({});
    expect(next.enclaves).not.toBe(config.enclaves);
    expect(next.enclaves?.executors.script).not.toBe(config.enclaves?.executors.script);
    expect(next.enclaves?.executors.agent).not.toBe(config.enclaves?.executors.agent);
    expect(next.enclaves?.executors.script.enabled).toBe(false);
    expect(next.enclaves?.executors.agent.enabled).toBe(false);
    expect(next.enclaves?.executors.agent.github).toBeUndefined();
    config.enclaves!.privateRepos.push({ repo: 'octo/private', sensitivity: 'internal' });
    config.enclaves!.executors.agent.repos.push({ repo: 'octo/private', sensitivity: 'internal' });
    expect(next.enclaves?.privateRepos).toEqual([]);
    expect(next.enclaves?.executors.agent.repos).toEqual([]);
    expect(MAIN_ACTION_STUB_CONFIG.enclaves).toBeUndefined();
  });
});

describeMainAction(({
  mockedDockerManager,
  mockedRedactSecrets,
  mockedEnclaveManager,
  mockedEnclaveGateway,
  mockedEnclaveGithubGateway,
  mockedEnclaveHostLifecycle,
  mockedExternalRuntimeResolver,
  platformHarness,
}) => {
  let previousExitSpy: jest.SpyInstance;

  it.each([1, 2])('shares module mocks and refreshes suite defaults (case %i)', async (testCase) => {
    expect(mockedEnclaveManager.prepareEnclaves).toBe(enclaveManager.prepareEnclaves);
    expect(mockedEnclaveGateway.shutdownEnclaveGateway).toBe(enclaveGateway.shutdownEnclaveGateway);
    expect(mockedEnclaveGithubGateway.resolveEnclaveGithubGatewayContract)
      .toBe(enclaveGithubGateway.resolveEnclaveGithubGatewayContract);
    expect(mockedEnclaveHostLifecycle.isCloudHypervisorEnclaveSelected)
      .toBe(enclaveHostLifecycle.isCloudHypervisorEnclaveSelected);
    expect(mockedExternalRuntimeResolver.resolveExternalRuntimeBackend)
      .toBe(externalRuntimeResolver.resolveExternalRuntimeBackend);
    expect(process.platform).toBe('linux');
    expect(process.geteuid?.()).toBe(0);
    expect(platformHarness.processExitSpy).not.toBe(previousExitSpy);
    expect(mockedEnclaveManager.prepareEnclaves).not.toHaveBeenCalled();
    await expect(mockedEnclaveManager.prepareEnclaves(MAIN_ACTION_STUB_CONFIG))
      .resolves.toBeUndefined();
    await expect(mockedDockerManager.runAgentCommand('/synthetic/awf-test', ['github.com']))
      .resolves.toEqual({ exitCode: 0, blockedDomains: [] });
    expect(mockedRedactSecrets.deriveSensitiveEndpointForms()).toEqual([]);
    expect(mockedRedactSecrets.deriveSensitiveEndpointForms(['private.example']))
      .toEqual(['private.example']);
    expect(mockedRedactSecrets.redactSensitiveValues('private private', ['private']))
      .toBe('[REDACTED] [REDACTED]');
    previousExitSpy = platformHarness.processExitSpy;
    if (testCase === 1) {
      mockedEnclaveManager.prepareEnclaves.mockRejectedValue(new Error('overridden'));
      mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 42, blockedDomains: ['example.com'] });
      mockedRedactSecrets.deriveSensitiveEndpointForms.mockReturnValue(['overridden']);
      mockedRedactSecrets.redactSensitiveValues.mockReturnValue('overridden');
    }
  });
});

describe('getMainActionMocks', () => {
  it('returns the registered module mocks without replacing their identities', () => {
    const mocks = getMainActionMocks();
    expect(mocks.mockedDockerManager).toBe(dockerManager);
    expect(mocks.mockedHostIptables).toBe(hostIptables);
    expect(mocks.mockedLogger).toBe(logger);
    expect(jest.isMockFunction(mocks.mockedDockerManager.runAgentCommand)).toBe(true);
    expect(jest.isMockFunction(mocks.mockedPreflight.applyConfigFilePrecedence)).toBe(true);
    expect(jest.isMockFunction(mocks.mockedLogger.error)).toBe(true);
    expect(getMainActionMocks().mockedDockerManager).toBe(mocks.mockedDockerManager);
  });

  it('shares filesystem calls with the existing factory mocks', () => {
    fs.writeFileSync('/synthetic/mock-output', 'contents');
    expect(mainActionFsMocks.writeFileSync).toHaveBeenCalledWith(
      '/synthetic/mock-output', 'contents'
    );
    expect(fs.constants.O_WRONLY).toBe(jest.requireActual<typeof fs>('fs').constants.O_WRONLY);
  });
});

describe('setupMainActionTestHarness', () => {
  let harness: MainActionTestHarness;

  beforeEach(() => {
    harness = setupMainActionTestHarness();
  });

  afterEach(() => {
    harness.processExitSpy.mockRestore();
    harness.consoleErrorSpy.mockRestore();
  });

  it('provides default implementations without explicit dependency wiring', async () => {
    const mocks = getMainActionMocks();
    const config = mocks.mockedValidateOptions.validateOptions({}, 'echo hi');
    expect(config).toEqual(MAIN_ACTION_STUB_CONFIG);
    expect(config).not.toBe(MAIN_ACTION_STUB_CONFIG);
    expect(mocks.mockedOptionParsers.joinShellArgs(['echo', 'hi'])).toBe('echo hi');
    await expect(mocks.mockedDindProbe.probeSplitFilesystem('/synthetic/probe')).resolves.toEqual({
      prefix: undefined,
      splitDetected: false,
      inconclusive: false,
    });
    await expect(mocks.mockedSbxManager.isSbxAvailable()).resolves.toBe(true);
    expect(harness.getOptionValueSource('allowDomains')).toBeUndefined();
  });

  it('preserves the process.exit behavior expected by main-action tests', () => {
    expect(() => process.exit(1)).toThrow('process.exit: 1');
    expect(() => process.exit(0)).not.toThrow();
    expect(() => process.exit(42)).not.toThrow();
    expect(harness.processExitSpy.mock.calls).toEqual([[1], [0], [42]]);
  });
});

describe('setupMainActionPlatformHarness', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalGeteuid = process.geteuid;
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const harness = setupMainActionPlatformHarness();
  let previousExitSpy: jest.SpyInstance;

  it.each([1, 2])('sets up fresh Linux root state and spies (case %i)', () => {
    expect(process.platform).toBe('linux');
    expect(process.geteuid?.()).toBe(0);
    expect(process.exit).toBe(harness.processExitSpy);
    expect(console.error).toBe(harness.consoleErrorSpy);
    expect(harness.processExitSpy).not.toBe(previousExitSpy);
    expect(harness.processExitSpy).not.toHaveBeenCalled();
    expect(harness.getOptionValueSource()).toBeUndefined();
    previousExitSpy = harness.processExitSpy;
    harness.getOptionValueSource.mockReturnValue('cli');
    process.exit(0);
  });

  afterEach(() => {
    expect(process.geteuid).toBe(originalGeteuid);
    expect(process.exit).toBe(originalExit);
    expect(console.error).toBe(originalConsoleError);
  });

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(originalPlatform);
  });
});
