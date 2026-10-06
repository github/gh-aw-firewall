import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testHelpers } from './main-action';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { initializeEnclaveStartupProgress, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import type { WrapperConfig } from '../types';

describe('startup progress descriptor publication', () => {
  let directory: string;
  let recordPath: string;
  let config: WrapperConfig;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-progress-'));
    recordPath = path.join(directory, 'awf-startup-error.json');
    config = {
      workDir: directory, proxyLogsDir: directory,
      enclaves: normalizeEnclavesConfig([
        { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
      ]),
    } as WrapperConfig;
    initializeEnclaveStartupProgress(config);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('replaces longer progress records without trailing bytes and keeps the private parent', () => {
    updateEnclaveStartupProgress(config, { stage: 'artifact-preflight' });
    testHelpers.writeStartupFailureDiagnostic(config, new Error('x'.repeat(8192)));
    updateEnclaveStartupProgress(config, { stage: 'initialize', readiness: 'attempted', attempts: 1 });
    testHelpers.writeStartupFailureDiagnostic(
      config, new Error('Enclave startup in progress'), 'enclave-startup-progress',
    );
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(record).toMatchObject({
      phase: 'enclave-startup-progress', message: 'Enclave startup in progress',
      enclaveStartup: { stage: 'initialize', readiness: 'attempted', attempts: 1 },
    });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(recordPath).uid).toBe(process.getuid?.());
    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o644);
  });

  it.each(['symlink', 'hardlink'])('refuses a %s record without modifying its target', (kind) => {
    const target = path.join(directory, 'private-target');
    fs.writeFileSync(target, 'PRIVATE_SENTINEL', { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(target, recordPath);
    else fs.linkSync(target, recordPath);
    testHelpers.writeStartupFailureDiagnostic(config, new Error('startup failed'));
    expect(fs.readFileSync(target, 'utf8')).toBe('PRIVATE_SENTINEL');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('bounds JSON-escaped fatal messages as well as their unescaped byte length', () => {
    testHelpers.writeStartupFailureDiagnostic(config, new Error('\u0000'.repeat(4096)));
    const bytes = fs.readFileSync(recordPath);
    expect(bytes.length).toBeLessThan(16 * 1024);
    expect(JSON.parse(bytes.toString('utf8')).message)
      .toBe('Enclave startup failure exceeded diagnostic message bound');
  });

  it('does not follow a record pathname replaced after descriptor validation', () => {
    fs.writeFileSync(recordPath, 'original', { mode: 0o600 });
    const original = path.join(directory, 'opened-record');
    const target = path.join(directory, 'private-target');
    fs.writeFileSync(target, 'PRIVATE_SENTINEL', { mode: 0o600 });
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const fstat = nodeFs.fstatSync;
    jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const stat = fstat(...args);
      fs.renameSync(recordPath, original);
      fs.symlinkSync(target, recordPath);
      return stat;
    });
    testHelpers.writeStartupFailureDiagnostic(config, new Error('startup failed'));
    expect(fs.readFileSync(target, 'utf8')).toBe('PRIVATE_SENTINEL');
    expect(JSON.parse(fs.readFileSync(original, 'utf8')).enclaveStartup.readiness).toBe('not-attempted');
  });
});
