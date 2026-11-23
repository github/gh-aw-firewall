import {
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  type EnclavesConfig,
  type WrapperConfig,
} from '../types';
import * as preflight from './preflight';
import * as validateOptions from './validate-options';
import * as dockerManager from '../docker-manager';
import * as hostIptables from '../host-iptables';
import * as redactSecrets from '../redact-secrets';
import * as optionParsers from '../option-parsers';
import * as dindProbe from '../dind-probe';
import * as dindBootstrap from '../dind-bootstrap';
import * as signalHandler from './signal-handler';
import * as cliWorkflow from '../cli-workflow';
import * as sbxManager from '../sbx-manager';
import * as enclaveGateway from '../enclave/gateway';
import * as enclaveGithubGateway from '../enclave/github-gateway';
import * as enclaveHostLifecycle from '../enclave/cloud-hypervisor-lifecycle';
import * as enclaveManager from '../enclave/manager';
import * as externalRuntimeResolver from '../external-runtime-backend-resolver';
import { logger } from '../logger';

export const MAIN_ACTION_STUB_CONFIG = {
  allowedDomains: ['github.com'],
  blockedDomains: undefined,
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/synthetic/awf-test',
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
  buildLocal: false,
  dnsServers: ['8.8.8.8'],
  awfDockerHost: undefined,
  proxyLogsDir: undefined,
  auditDir: undefined,
  sessionStateDir: undefined,
} as unknown as WrapperConfig;

export function makeSbxConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    ...MAIN_ACTION_STUB_CONFIG,
    containerRuntime: 'sbx',
    ...overrides,
  };
}

export function makeEnclaveConfig(executors: {
  [K in keyof EnclavesConfig['executors']]?: Partial<EnclavesConfig['executors'][K]>;
}): WrapperConfig {
  return {
    ...MAIN_ACTION_STUB_CONFIG,
    enclaves: {
      enabled: true,
      privateRepos: [],
      executors: {
        script: { ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS, ...executors.script },
        agent: { ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS, repos: [], ...executors.agent },
      },
    },
  };
}

interface MainActionHarnessDeps {
  mockedPreflight: Pick<jest.Mocked<typeof preflight>, 'applyConfigFilePrecedence'>;
  mockedValidateOptions: Pick<jest.Mocked<typeof validateOptions>, 'validateOptions'>;
  mockedDockerManager: Pick<jest.Mocked<typeof dockerManager>, 'setAwfDockerHost'>;
  mockedRedactSecrets: Pick<jest.Mocked<typeof redactSecrets>, 'redactSecrets'>;
  mockedOptionParsers: Pick<jest.Mocked<typeof optionParsers>, 'joinShellArgs'>;
  mockedDindProbe: Pick<jest.Mocked<typeof dindProbe>, 'probeSplitFilesystem'>;
  mockedDindBootstrap: Pick<jest.Mocked<typeof dindBootstrap>, 'runDindBootstrap'>;
  mockedSignalHandler: Pick<jest.Mocked<typeof signalHandler>, 'registerSignalHandlers'>;
  mockedCliWorkflow: Pick<jest.Mocked<typeof cliWorkflow>, 'runMainWorkflow'>;
  mockedSbxManager: Pick<
    jest.Mocked<typeof sbxManager>,
    'isSbxAvailable' | 'createSandbox' | 'assertSbxApiProxyReflect' | 'execInSandbox' | 'removeSandbox'
  >;
}

export interface MainActionTestHarness {
  processExitSpy: jest.SpyInstance;
  consoleErrorSpy: jest.SpyInstance;
  getOptionValueSource: jest.Mock;
}

interface MainActionMocks {
  mockedPreflight: jest.Mocked<typeof preflight>;
  mockedValidateOptions: jest.Mocked<typeof validateOptions>;
  mockedDockerManager: jest.Mocked<typeof dockerManager>;
  mockedHostIptables: jest.Mocked<typeof hostIptables>;
  mockedRedactSecrets: jest.Mocked<typeof redactSecrets>;
  mockedOptionParsers: jest.Mocked<typeof optionParsers>;
  mockedDindProbe: jest.Mocked<typeof dindProbe>;
  mockedDindBootstrap: jest.Mocked<typeof dindBootstrap>;
  mockedSignalHandler: jest.Mocked<typeof signalHandler>;
  mockedCliWorkflow: jest.Mocked<typeof cliWorkflow>;
  mockedSbxManager: jest.Mocked<typeof sbxManager>;
  mockedLogger: jest.Mocked<typeof logger>;
}

export function getMainActionMocks(): MainActionMocks {
  return {
    mockedPreflight: jest.mocked(preflight, { shallow: true }),
    mockedValidateOptions: jest.mocked(validateOptions, { shallow: true }),
    mockedDockerManager: jest.mocked(dockerManager, { shallow: true }),
    mockedHostIptables: jest.mocked(hostIptables, { shallow: true }),
    mockedRedactSecrets: jest.mocked(redactSecrets, { shallow: true }),
    mockedOptionParsers: jest.mocked(optionParsers, { shallow: true }),
    mockedDindProbe: jest.mocked(dindProbe, { shallow: true }),
    mockedDindBootstrap: jest.mocked(dindBootstrap, { shallow: true }),
    mockedSignalHandler: jest.mocked(signalHandler, { shallow: true }),
    mockedCliWorkflow: jest.mocked(cliWorkflow, { shallow: true }),
    mockedSbxManager: sbxManager as jest.Mocked<typeof sbxManager>,
    mockedLogger: jest.mocked(logger, { shallow: true }),
  };
}

interface MainActionSuiteContext extends MainActionMocks {
  mockedEnclaveGateway: jest.Mocked<typeof enclaveGateway>;
  mockedEnclaveGithubGateway: jest.Mocked<typeof enclaveGithubGateway>;
  mockedEnclaveHostLifecycle: jest.Mocked<typeof enclaveHostLifecycle>;
  mockedEnclaveManager: jest.Mocked<typeof enclaveManager>;
  mockedExternalRuntimeResolver: jest.Mocked<typeof externalRuntimeResolver>;
  platformHarness: MainActionTestHarness;
}

// Import main-action-enclave-mocks.test-utils before using this suite setup.
export function describeMainAction(tests: (context: MainActionSuiteContext) => void): void {
  describe('createMainAction', () => {
    const mocks = getMainActionMocks();
    const mockedEnclaveManager = jest.mocked(enclaveManager, { shallow: true });
    const platformHarness = setupMainActionPlatformHarness();

    beforeEach(() => {
      mockedEnclaveManager.prepareEnclaves.mockResolvedValue(undefined);
      mocks.mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 0, blockedDomains: [] });
      mocks.mockedRedactSecrets.deriveSensitiveEndpointForms.mockImplementation((domains?: string[]) =>
        domains ?? []
      );
      mocks.mockedRedactSecrets.redactSensitiveValues.mockImplementation((value: string, values: string[]) =>
        values.reduce((redacted, sensitive) => redacted.split(sensitive).join('[REDACTED]'), value)
      );
    });

    tests({
      ...mocks,
      mockedEnclaveGateway: jest.mocked(enclaveGateway, { shallow: true }),
      mockedEnclaveGithubGateway: jest.mocked(enclaveGithubGateway, { shallow: true }),
      mockedEnclaveHostLifecycle: jest.mocked(enclaveHostLifecycle, { shallow: true }),
      mockedEnclaveManager,
      mockedExternalRuntimeResolver: jest.mocked(externalRuntimeResolver, { shallow: true }),
      platformHarness,
    });
  });
}

export function setupMainActionTestHarness(
  deps: MainActionHarnessDeps = getMainActionMocks()
): MainActionTestHarness {
  jest.clearAllMocks();
  const processExitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    if (code === 1) {
      throw new Error(`process.exit: ${code}`);
    }
    return undefined as never;
  });
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  const getOptionValueSource = jest.fn().mockReturnValue(undefined);

  deps.mockedPreflight.applyConfigFilePrecedence.mockImplementation(() => {});
  deps.mockedValidateOptions.validateOptions.mockImplementation(
    () => ({ ...MAIN_ACTION_STUB_CONFIG } as unknown as WrapperConfig)
  );
  deps.mockedDockerManager.setAwfDockerHost.mockImplementation(() => {});
  deps.mockedRedactSecrets.redactSecrets.mockImplementation((s: string) => s);
  deps.mockedOptionParsers.joinShellArgs.mockImplementation((args: string[]) => args.join(' '));
  deps.mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
    prefix: undefined,
    splitDetected: false,
    inconclusive: false,
  });
  deps.mockedDindBootstrap.runDindBootstrap.mockResolvedValue(undefined);
  deps.mockedSignalHandler.registerSignalHandlers.mockImplementation(() => {});
  deps.mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
  deps.mockedSbxManager.isSbxAvailable.mockResolvedValue(true);
  deps.mockedSbxManager.createSandbox.mockResolvedValue('awf-agent-test');
  deps.mockedSbxManager.assertSbxApiProxyReflect.mockResolvedValue(undefined);
  deps.mockedSbxManager.execInSandbox.mockResolvedValue({ exitCode: 0 });
  deps.mockedSbxManager.removeSandbox.mockResolvedValue(undefined);

  return {
    processExitSpy,
    consoleErrorSpy,
    getOptionValueSource,
  };
}

export function setupMainActionPlatformHarness(): MainActionTestHarness {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let harness: MainActionTestHarness;
  let effectiveUidSpy: jest.SpyInstance;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  beforeEach(() => {
    effectiveUidSpy = jest.spyOn(process, 'geteuid').mockReturnValue(0);
    harness = setupMainActionTestHarness();
  });

  afterEach(() => {
    harness.processExitSpy.mockRestore();
    harness.consoleErrorSpy.mockRestore();
    effectiveUidSpy.mockRestore();
  });

  return {
    get processExitSpy() { return harness.processExitSpy; },
    get consoleErrorSpy() { return harness.consoleErrorSpy; },
    get getOptionValueSource() { return harness.getOptionValueSource; },
  };
}
