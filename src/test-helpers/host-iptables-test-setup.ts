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

export const mockedExeca = execa as unknown as jest.MockedFunction<MockedExecaFn>;

export function execaResult(overrides: Partial<ExecaMockResult> = {}): ExecaMockResult {
  return {
    ...defaultExecaResult,
    ...overrides,
  };
}

export function execaError(message: string, stderr = message): ExecaMockError {
  return Object.assign(new Error(message), { stderr });
}

export function setupHostIptablesTestSuite(resetIpv6State: () => void): void {
  beforeEach(() => {
    jest.clearAllMocks();
    resetIpv6State();
  });
}

export function setupDefaultIptablesMocks(
  opts: {
    chainExists?: boolean;
    bridgeName?: string;
    catchAllStdout?: string;
  } = {}
): void {
  const { chainExists = false, bridgeName = 'fw-bridge', catchAllStdout = '' } = opts;
  mockedExeca
    .mockResolvedValueOnce(execaResult({ stdout: bridgeName, exitCode: 0 }))
    .mockResolvedValueOnce(execaResult({ stdout: '', exitCode: 0 }))
    .mockResolvedValueOnce(execaResult({ exitCode: chainExists ? 0 : 1 }));
  mockedExeca.mockResolvedValue(execaResult({ stdout: catchAllStdout, exitCode: 0 }));
}
