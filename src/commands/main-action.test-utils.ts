import type { WrapperConfig } from '../types';
import type * as preflight from './preflight';
import type * as validateOptions from './validate-options';
import type * as dockerManager from '../docker-manager';
import type * as redactSecrets from '../redact-secrets';
import type * as optionParsers from '../option-parsers';
import type * as dindProbe from '../dind-probe';
import type * as dindBootstrap from '../dind-bootstrap';
import type * as signalHandler from './signal-handler';
import type * as cliWorkflow from '../cli-workflow';
import type * as sbxManager from '../sbx-manager';

export const MAIN_ACTION_STUB_CONFIG = {
  allowedDomains: ['github.com'],
  blockedDomains: undefined,
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-test',
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
  buildLocal: false,
  dnsServers: ['8.8.8.8'],
  awfDockerHost: undefined,
  proxyLogsDir: undefined,
  auditDir: undefined,
  sessionStateDir: undefined,
} as unknown as WrapperConfig;

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

// Note: jest.mock('fs') with its factory closure variables cannot be centralized
// here. Jest hoists jest.mock calls before import statements, so the factory
// must close over variables declared in the same test file. Each suite keeps its
// own jest.mock('fs') block and the local const mock* declarations it closes over.

export function setupMainActionTestHarness(deps: MainActionHarnessDeps): MainActionTestHarness {
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
