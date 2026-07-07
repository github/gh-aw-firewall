/**
 * Branch and line coverage for previously-uncovered paths in:
 *  - src/host-env.ts  (stripScheme error branch)
 *  - src/commands/validators/agent-options.ts
 *                     (env success path, invalid env-file, invalid mount,
 *                      valid mount success path, enableDlp log path)
 */

// ─── host-env.ts ─────────────────────────────────────────────────────────────

import { stripScheme } from './host-env';

describe('host-env: stripScheme — error branch (line 81)', () => {
  it('returns trimmed value unchanged when the URL constructor throws on the candidate', () => {
    // A bare string with spaces produces "https://not a valid url" which is invalid.
    const value = 'not a valid url with spaces';
    expect(stripScheme(value)).toBe(value.trim());
  });

  it('returns empty string for empty input', () => {
    expect(stripScheme('')).toBe('');
    expect(stripScheme('   ')).toBe('');
  });

  it('strips scheme from a valid https URL', () => {
    expect(stripScheme('https://api.example.com/path')).toBe('api.example.com');
  });

  it('handles bare hostname without scheme', () => {
    expect(stripScheme('api.example.com')).toBe('api.example.com');
  });
});

// ─── agent-options.ts ────────────────────────────────────────────────────────

jest.mock('./option-parsers', () => ({
  parseEnvironmentVariables: jest.fn(),
  parseVolumeMounts: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

import { validateAgentOptions } from './commands/validators/agent-options';
import { parseEnvironmentVariables, parseVolumeMounts } from './option-parsers';

const fsMock = jest.requireMock('fs') as { existsSync: jest.Mock };
const parseEnvMock = parseEnvironmentVariables as jest.MockedFunction<typeof parseEnvironmentVariables>;
const parseMountMock = parseVolumeMounts as jest.MockedFunction<typeof parseVolumeMounts>;

describe('validateAgentOptions', () => {
  const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as any);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  it('sets additionalEnv when parseEnvironmentVariables succeeds (line 45)', () => {
    parseEnvMock.mockReturnValue({ success: true, env: { FOO: 'bar' } });

    const result = validateAgentOptions({ env: ['FOO=bar'] });
    expect(result.additionalEnv).toEqual({ FOO: 'bar' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits when parseEnvironmentVariables fails (branch 39)', () => {
    parseEnvMock.mockReturnValue({ success: false, invalidVar: 'BADVAR' });

    expect(() => validateAgentOptions({ env: ['BADVAR'] })).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits when envFile does not exist (branch 50)', () => {
    fsMock.existsSync.mockReturnValue(false);

    expect(() =>
      validateAgentOptions({ envFile: '/no/such/file.env' })
    ).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('does not exit when envFile exists (branch 50 — true path)', () => {
    fsMock.existsSync.mockReturnValue(true);

    const result = validateAgentOptions({ envFile: '/valid/file.env' });
    expect(mockExit).not.toHaveBeenCalled();
    expect(result.additionalEnv).toEqual({});
  });

  it('sets volumeMounts when parseVolumeMounts succeeds (lines 67-68)', () => {
    parseMountMock.mockReturnValue({ success: true, mounts: ['/host:/container:ro'] });

    const result = validateAgentOptions({ mount: ['/host:/container:ro'] });
    expect(result.volumeMounts).toEqual(['/host:/container:ro']);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits when parseVolumeMounts fails (branch 62)', () => {
    parseMountMock.mockReturnValue({
      success: false,
      invalidMount: 'bad-mount',
      reason: 'missing colon separator',
    });

    expect(() =>
      validateAgentOptions({ mount: ['bad-mount'] })
    ).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('does not exit when enableDlp is true (line 141, branch 140)', () => {
    const result = validateAgentOptions({ enableDlp: true });
    expect(mockExit).not.toHaveBeenCalled();
    expect(result.additionalEnv).toEqual({});
  });

  it('returns empty result when no options are provided', () => {
    const result = validateAgentOptions({});
    expect(result.additionalEnv).toEqual({});
    expect(result.volumeMounts).toBeUndefined();
    expect(result.allowedUrls).toBeUndefined();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
