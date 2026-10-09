import * as fs from 'fs';
import * as path from 'path';
import { captureEnclaveStartupDiagnostics, enclaveStartupDiagnosticTestHelpers } from './startup-diagnostics';
import { useTempDir } from '../test-helpers/docker-test-fixtures.test-utils';
import { mockExecaFn } from '../test-helpers/mock-execa.test-utils';
import { logger } from '../logger';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('../logger', () => ({ logger: { warn: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startupDiagnostic } = require('../../containers/enclave/mcp-server/startup-diagnostics.js');
const { classifyLogs, safeState } = enclaveStartupDiagnosticTestHelpers;

describe('bounded enclave startup evidence', () => {
  const { getDir } = useTempDir();
  const state = '{"status":"exited","running":false,"exitCode":1,"oomKilled":false,"hasError":true}';
  const sensitive = 'Bearer SECRET capability=CAP private/repo /awf/seed/private';

  function snapshots(directory = path.join(getDir(), 'squid-logs')) {
    const root = path.join(directory, 'enclave-startup');
    return fs.readdirSync(root).map(name => {
      const file = path.join(root, name, 'diagnostic.json');
      return { file, text: fs.readFileSync(file, 'utf8') };
    });
  }

  beforeEach(() => {
    mockExecaFn.mockReset();
    jest.mocked(logger.warn).mockClear();
  });

  it('origin output drops messages, unknown codes, paths and non-AWF frames', () => {
    const error = new TypeError(sensitive);
    Object.assign(error, {
      code: 'ENOENT',
      stack: `TypeError: ${sensitive}\n`
        + '    at load (/opt/awf/enclave/mcp-server/config.js:22:3)\n'
        + '    at seed (/awf/seed/private.js:4:1)\n'
        + '    at evil (/tmp/mcp-server/config.js:1:2)',
    });
    const diagnostic = startupDiagnostic(error, 'server-config');
    expect(diagnostic).toMatchObject({
      stage: 'server-config', code: 'ENOENT', errorType: 'TypeError',
      frames: [{ module: 'mcp-server/config.js', line: 22, column: 3 }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
    expect(startupDiagnostic({ message: sensitive, name: sensitive, code: sensitive }, sensitive))
      .toMatchObject({ stage: 'unknown', code: 'unknown', errorType: 'unknown', frames: [] });
  });

  it('the actual server startup catch emits only safe origin diagnostics', () => {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../containers/enclave/mcp-server/server.js'),
    ], { env: {}, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      component: 'enclave-mcp-server', kind: 'startup-error',
      stage: 'server-config', errorType: 'Error',
    });
    expect(result.stderr).not.toMatch(/Missing required|environment|auth-token|\/srv\/|\/run\//);
  });

  it('validates origin fields again rather than trusting container-produced JSON', () => {
    const output = classifyLogs(JSON.stringify({
      component: 'enclave-mcp-server', kind: 'startup-error', stage: sensitive,
      errorType: sensitive, code: sensitive, message: sensitive,
      frames: [
        { module: sensitive, line: 1, column: 1 },
        { module: 'mcp-server/server.js', line: sensitive, column: 1 },
        { module: 'mcp-server/server.js', line: 42, column: 9, secret: sensitive },
      ],
    }));
    expect(output).toEqual({
      source: 'origin', stage: 'unknown', errorType: 'unknown', code: 'unknown',
      frames: [{ module: 'mcp-server/server.js', line: 42, column: 9 }],
    });
    expect(JSON.stringify(output)).not.toContain('SECRET');
  });

  it('classifies legacy and module-load errors without retaining raw log evidence', () => {
    expect(classifyLogs(`Error: Cannot find module ${sensitive}\n code: MODULE_NOT_FOUND`))
      .toMatchObject({ source: 'docker-log-classification', errorType: 'Error', code: 'MODULE_NOT_FOUND' });
    expect(JSON.stringify(classifyLogs(`Error: EACCES ${sensitive}`))).not.toContain('SECRET');
    expect(classifyLogs('ENOENT\n' + 'x'.repeat(20000))).toMatchObject({ code: 'unknown' });
    const frames = Array.from({ length: 20 }, () => ({ module: 'mcp-server/server.js', line: 1, column: 1 }));
    expect(classifyLogs(JSON.stringify({
      component: 'enclave-mcp-server', kind: 'startup-error', frames,
    })).frames).toHaveLength(8);
  });

  it('retains separate startup and cleanup snapshots in firewall logs across attempts', async () => {
    mockExecaFn.mockImplementation(async (_command, args) => args[0] === 'inspect'
      ? { exitCode: 0, stdout: state, stderr: sensitive }
      : { exitCode: 0, stdout: '', stderr: `Error: ENOENT ${sensitive}` });
    const logDir = path.join(getDir(), 'firewall', 'logs');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'shutdown-failure');
    const records = snapshots(logDir);
    expect(records).toHaveLength(3);
    for (const snapshot of records) {
      expect(snapshot.text).not.toContain('SECRET');
      expect(snapshot.text.length).toBeLessThan(2048);
      expect(fs.statSync(snapshot.file).mode & 0o777).toBe(0o644);
      expect(JSON.parse(snapshot.text)).toMatchObject({
        inspectStatus: 'captured', state: { exitCode: 1, oomKilled: false, hasError: true },
        logsStatus: 'classified', logs: { code: 'ENOENT' },
      });
    }
    for (const [, args, options] of mockExecaFn.mock.calls) {
      expect(options).toMatchObject({ timeout: 5000, maxBuffer: 16384, reject: false });
      expect(args).not.toContain('env');
    }
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('SECRET');
  });

  it('records unavailable state and logs without leaking collection errors', async () => {
    mockExecaFn.mockRejectedValue(new Error(sensitive));
    await captureEnclaveStartupDiagnostics(getDir(), undefined, 'startup-failure');
    expect(JSON.parse(snapshots()[0].text)).toMatchObject({
      inspectStatus: 'unavailable', state: null, logsStatus: 'unavailable', logs: null,
    });
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('SECRET');
    expect(safeState('{"status":"SECRET","exitCode":99999,"Error":"SECRET"}'))
      .toMatchObject({ status: 'unknown', exitCode: null });
  });

  it('caps retention without deleting or overwriting earlier attempts', async () => {
    mockExecaFn.mockResolvedValue({ exitCode: 1, stdout: '', stderr: sensitive });
    for (let attempt = 0; attempt < 9; attempt++) {
      await captureEnclaveStartupDiagnostics(getDir(), undefined, 'startup-failure');
    }
    expect(snapshots()).toHaveLength(8);
    expect(mockExecaFn).toHaveBeenCalledTimes(16);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retention limit'));
  });

  it('reports retention errors without masking the original startup failure', async () => {
    const logDir = path.join(getDir(), 'not-a-directory');
    fs.writeFileSync(logDir, 'occupied');
    await expect(captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure')).resolves.toBeUndefined();
    expect(mockExecaFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to retain'));
  });

  it('does not follow a symlink used as the diagnostic directory', async () => {
    const outside = path.join(getDir(), 'outside');
    const logDir = path.join(getDir(), 'logs');
    fs.mkdirSync(outside);
    fs.mkdirSync(logDir);
    fs.symlinkSync(outside, path.join(logDir, 'enclave-startup'));
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockExecaFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to retain'));
  });
});
