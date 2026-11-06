import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { withEarlyStartupDiagnostics } from './early-startup-diagnostics';

const root = path.resolve(__dirname, '../..');
const marker = 'AWF_EARLY_STARTUP_FAILURE ';
const modulePath = path.join(root, 'dist/logs/early-startup-diagnostics.js');
const cliPath = path.join(root, 'dist/cli.js');
const parse = (stderr: string) => stderr.split('\n').filter(line => line.startsWith(marker))
  .map(line => JSON.parse(line.slice(marker.length)));

afterEach(() => jest.restoreAllMocks());

it('emits only an allowlisted reason at the innermost failing phase and preserves the error', () => {
  const write = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'writeSync').mockReturnValue(1);
  const error = Object.assign(new Error('PRIVATE_PROMPT_CREDENTIAL_CAPABILITY'), {
    code: 'cloud-hypervisor-enclave-admission',
  });
  const listeners = process.listenerCount('exit');
  expect(() => withEarlyStartupDiagnostics('validation', () =>
    withEarlyStartupDiagnostics('backend-selection', () => { throw error; }))).toThrow(error);
  expect(parse(String(write.mock.calls[0][1]))).toEqual([{
    schemaVersion: 1, phase: 'backend-selection', reason: 'cloud-hypervisor-enclave-admission',
  }]);
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(write.mock.calls)).not.toContain('PRIVATE_');
  expect(process.listenerCount('exit')).toBe(listeners);
});

it('clamps unknown error codes and emits nothing for success or a handled fallback', () => {
  const write = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'writeSync').mockReturnValue(1);
  expect(withEarlyStartupDiagnostics('backend-selection', () => {
    try { throw new Error('handled fallback'); } catch { return 'docker'; }
  })).toBe('docker');
  expect(write).not.toHaveBeenCalled();
  expect(() => withEarlyStartupDiagnostics('validation', () => {
    throw Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'PRIVATE_CODE' });
  })).toThrow('PRIVATE_MESSAGE');
  expect(parse(String(write.mock.calls[0][1]))[0].reason).toBe('validation-rejected');
});

it.each(['configuration', 'validation', 'backend-selection'])(
  'captures explicit process.exit before a startup record exists (%s)', phase => {
    const child = spawnSync(process.execPath, ['-e',
      `require(${JSON.stringify(modulePath)}).withEarlyStartupDiagnostics(${JSON.stringify(phase)}, () => process.exit(1))`,
    ], { encoding: 'utf8', timeout: 10_000 });
    expect(child.status).toBe(1);
    expect(parse(child.stderr)).toEqual([{
      schemaVersion: 1, phase, reason: `${phase}-rejected`,
    }]);
  },
);

it.each([
  ['configuration', ['--config', 'missing-config.json']],
  ['validation', ['--memory-limit', 'invalid']],
  ['backend-selection', ['--container-runtime', 'cloud-hypervisor']],
])('classifies real CLI rejection before host or artifact preparation (%s)', (phase, options) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-early-startup-'));
  try {
    const child = spawnSync(process.execPath, [cliPath, ...options, '--', 'true'], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: '1' },
    });
    expect(child.status).toBe(1);
    expect(parse(child.stderr)).toEqual([{
      schemaVersion: 1, phase, reason: `${phase}-rejected`,
    }]);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
