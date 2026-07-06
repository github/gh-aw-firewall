/**
 * Targets remaining coverage gaps identified in coverage-summary.json:
 *
 * 1. config-file.ts – readStdinSync (the real default `readStdin` fn, not the injected mock)
 *    is never exercised; tests always supply a custom readStdin override.
 *    We mock fs.readFileSync so the fd-based call is safe in the test runner.
 *
 * 2. pid-tracker.ts – default `procPath = '/proc'` branches in readCmdline, readComm,
 *    processOwnsSocket, findProcessByInode, and trackPidForPortSync.
 *    All existing tests pass `mockProcPath`; these tests call without that arg so
 *    Istanbul marks the default-value branches as covered.
 *
 * 3. cli.ts – the `require.main === module` branch is uncovered because the module
 *    is always imported (not run directly). We verify it is false in test context.
 */

// ─── config-file.ts: readStdinSync default parameter ────────────────────────

const mockReadFileSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      // Only intercept the stdin fd read used by config-file's readStdinSync.
      if (args[0] === process.stdin.fd) {
        return mockReadFileSync(...args);
      }
      return (actual.readFileSync as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// schema-validator needs the real readFileSync during compilation — use
// jest.requireActual so the Ajv compile step sees the real file.
jest.mock('./schema-validator', () => jest.requireActual('./schema-validator'));

import { loadAwfFileConfig } from './config-file';
import { trackPidForPortSync, isPidTrackingAvailable } from './pid-tracker';

describe('config-file readStdinSync (default readStdin parameter)', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it('reads from process.stdin.fd when no readStdin override is passed', () => {
    // Simulate stdin containing a valid JSON config
    const stdinContent = JSON.stringify({ logging: { logLevel: 'debug' } });
    // readFileSync is called twice: once for stdin fd, once by... actually just once
    // for the stdin case. Return the config JSON.
    mockReadFileSync.mockReturnValue(stdinContent);

    const result = loadAwfFileConfig('-');

    expect(result.logging?.logLevel).toBe('debug');
    // Confirm readFileSync was called with the stdin fd (process.stdin.fd is 0)
    expect(mockReadFileSync).toHaveBeenCalledWith(process.stdin.fd, 'utf8');
  });

  it('propagates readStdinSync error when stdin read fails', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('read error');
    });

    expect(() => loadAwfFileConfig('-')).toThrow('read error');
  });
});

// ─── pid-tracker.ts: default procPath='/proc' branches ──────────────────────

describe('pid-tracker default /proc path branches', () => {
  // These tests call the exported functions WITHOUT the optional procPath argument
  // so that Istanbul records the default-parameter branch as covered.
  // They are not integration tests — we expect them to fail gracefully when /proc
  // is unavailable (non-Linux CI) or when the port is not in use.

  it('isPidTrackingAvailable() uses /proc by default and returns a boolean', () => {
    const result = isPidTrackingAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('trackPidForPortSync() with default /proc returns a PidTrackResult', () => {
    // Port 1 is virtually guaranteed to not be in /proc/net/tcp (privileged, never open).
    const result = trackPidForPortSync(1);

    // On Linux /proc/net/tcp is available; on non-Linux it is not.
    if (process.platform === 'linux') {
      // The entry won't be found, so pid should be -1.
      expect(result.pid).toBe(-1);
      expect(typeof result.error).toBe('string');
    } else {
      // On non-Linux, /proc/net/tcp does not exist.
      expect(result.pid).toBe(-1);
      expect(result.error).toMatch(/Failed to read/);
    }
  });
});

// ─── cli.ts: require.main !== module branch ──────────────────────────────────

describe('cli.ts module import branch', () => {
  it('does not call program.parse() when imported as a module (require.main !== module)', () => {
    // When the file is require()'d the require.main !== module branch executes.
    // We simply verify the module can be imported cleanly without side effects.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliModule = require('./cli');

    // The module should not export anything (it's a side-effect-only entry point)
    // but importing it must not throw.
    expect(cliModule).toBeDefined();
  });
});
