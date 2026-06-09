import execa from 'execa';

jest.mock('execa');
jest.mock('../docker-manager', () => ({
  getLocalDockerEnv: () => process.env,
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('./mock-logger.test-utils').loggerMockFactory());

type ExecaMockError = Error & { stderr?: string };
type MockedExecaFn = (file: string, args?: readonly string[], options?: unknown) => Promise<ExecaMockResult>;

interface ExecaMockResult {
  command: string;
  escapedCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  killed: boolean;
  signal?: string;
  signalDescription?: string;
  isCanceled: boolean;
  all?: string;
}

const defaultExecaResult: ExecaMockResult = {
  command: '',
  escapedCommand: '',
  exitCode: 0,
  stdout: '',
  stderr: '',
  failed: false,
  timedOut: false,
  killed: false,
  signal: undefined,
  signalDescription: undefined,
  isCanceled: false,
  all: undefined,
};

// ts-prune-ignore-next
export const mockedExeca = execa as unknown as jest.MockedFunction<MockedExecaFn>;

// ts-prune-ignore-next
export function execaResult(overrides: Partial<ExecaMockResult> = {}): ExecaMockResult {
  return {
    ...defaultExecaResult,
    ...overrides,
  };
}

// ts-prune-ignore-next
export function execaError(message: string, stderr = message): ExecaMockError {
  return Object.assign(new Error(message), { stderr });
}

// ts-prune-ignore-next
export function setupHostIptablesTestSuite(resetIpv6State: () => void): void {
  beforeEach(() => {
    jest.clearAllMocks();
    resetIpv6State();
  });
}

// ts-prune-ignore-next
export function setupDefaultIptablesMocks(
  opts: {
    chainExists?: boolean;
    bridgeName?: string;
    catchAllStdout?: string;
    /** Whether the DOCKER-USER jump rule already exists (controls iptables -C exit code). Default: false. */
    dockerUserJumpRuleExists?: boolean;
  } = {}
): void {
  const { chainExists = false, bridgeName = 'fw-bridge', catchAllStdout = '', dockerUserJumpRuleExists = false } = opts;
  mockedExeca
    .mockResolvedValueOnce(execaResult({ stdout: bridgeName, exitCode: 0 }))
    .mockResolvedValueOnce(execaResult({ stdout: '', exitCode: 0 }))
    .mockResolvedValueOnce(execaResult({ exitCode: chainExists ? 0 : 1 }));
  mockedExeca.mockImplementation(((cmd: string, args: readonly string[]) => {
    if (cmd === 'iptables' && Array.isArray(args) && args.includes('-C')) {
      return Promise.resolve(execaResult({ stdout: '', exitCode: dockerUserJumpRuleExists ? 0 : 1 }));
    }
    return Promise.resolve(execaResult({ stdout: catchAllStdout, exitCode: 0 }));
  }) as MockedExecaFn);
}

// ts-prune-ignore-next
export function setupDockerBridgeMock(opts: {
  gateway?: string;
  exitCode?: number;
  stderr?: string;
  error?: Error;
} = {}): void {
  const {
    gateway = '172.17.0.1',
    exitCode = 0,
    stderr = '',
    error,
  } = opts;

  const previousImplementation = mockedExeca.getMockImplementation();

  const mockImplementation: MockedExecaFn = (cmd: string, args: readonly string[] = [], options?: unknown) => {
    if (cmd === 'docker' && args.includes('bridge')) {
      if (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(execaResult({ stdout: gateway, stderr, exitCode }));
    }

    return previousImplementation
      ? previousImplementation(cmd, args, options)
      : Promise.resolve(execaResult({ stdout: '', stderr: '', exitCode: 0 }));
  };

  mockedExeca.mockImplementation(mockImplementation);
}
