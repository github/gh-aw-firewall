import type { WrapperConfig } from '../types';

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
  mockedPreflight: { applyConfigFilePrecedence: unknown };
  mockedValidateOptions: { validateOptions: unknown };
  mockedDockerManager: { setAwfDockerHost: unknown };
  mockedRedactSecrets: { redactSecrets: unknown };
  mockedOptionParsers: { joinShellArgs: unknown };
  mockedDindProbe: { probeSplitFilesystem: unknown };
  mockedDindBootstrap: { runDindBootstrap: unknown };
  mockedSignalHandler: { registerSignalHandlers: unknown };
  mockedCliWorkflow: { runMainWorkflow: unknown };
  mockedSbxManager: {
    isSbxAvailable: unknown;
    createSandbox: unknown;
    execInSandbox: unknown;
    removeSandbox: unknown;
  };
}

export interface MainActionTestHarness {
  processExitSpy: jest.SpyInstance;
  consoleErrorSpy: jest.SpyInstance;
  getOptionValueSource: jest.Mock;
}

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

  (deps.mockedPreflight.applyConfigFilePrecedence as jest.Mock).mockImplementation(() => {});
  (deps.mockedValidateOptions.validateOptions as jest.Mock).mockImplementation(
    () => ({ ...MAIN_ACTION_STUB_CONFIG } as unknown as WrapperConfig)
  );
  (deps.mockedDockerManager.setAwfDockerHost as jest.Mock).mockImplementation(() => {});
  (deps.mockedRedactSecrets.redactSecrets as jest.Mock).mockImplementation((s: string) => s);
  (deps.mockedOptionParsers.joinShellArgs as jest.Mock).mockImplementation((args: string[]) => args.join(' '));
  (deps.mockedDindProbe.probeSplitFilesystem as jest.Mock).mockResolvedValue({
    prefix: undefined,
    splitDetected: false,
    inconclusive: false,
  });
  (deps.mockedDindBootstrap.runDindBootstrap as jest.Mock).mockResolvedValue(undefined);
  (deps.mockedSignalHandler.registerSignalHandlers as jest.Mock).mockImplementation(() => {});
  (deps.mockedCliWorkflow.runMainWorkflow as jest.Mock).mockResolvedValue(0);
  (deps.mockedSbxManager.isSbxAvailable as jest.Mock).mockResolvedValue(true);
  (deps.mockedSbxManager.createSandbox as jest.Mock).mockResolvedValue('awf-agent-test');
  (deps.mockedSbxManager.execInSandbox as jest.Mock).mockResolvedValue({ exitCode: 0 });
  (deps.mockedSbxManager.removeSandbox as jest.Mock).mockResolvedValue(undefined);

  return {
    processExitSpy,
    consoleErrorSpy,
    getOptionValueSource,
  };
}
