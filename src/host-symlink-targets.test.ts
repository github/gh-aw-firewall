import * as fs from 'fs';
import * as path from 'path';
import { prepareChrootHomeMounts } from './chroot-home-setup';
import { preserveIptablesAudit } from './artifact-preservation';
import { getRealUserHome } from './host-env';
import { logger } from './logger';
import { baseConfig, useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./host-env', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hostEnvMockFactory } = require('./test-helpers/fs-mock-factory.test-utils');
  return hostEnvMockFactory({ getLocalDockerEnv: jest.fn().mockReturnValue({}) });
});
jest.mock('./enclave/paths', () => ({
  resolveEnclavePaths: (workDir: string) => ({ root: `${workDir}/enclave` }),
}));

const actualFs = jest.requireActual<typeof import('fs')>('fs');

describe('host ownership targets', () => {
  const { getDir } = useTempDir('awf-ownership-targets-');

  beforeEach(() => {
    jest.mocked(getRealUserHome).mockImplementation(getDir);
  });

  afterEach(() => {
    fs.rmSync(`${getDir()}-chroot-home`, { recursive: true, force: true });
    (fs.lstatSync as jest.Mock).mockImplementation(actualFs.lstatSync);
  });

  it.each(['symlink', 'file'])('refuses a chroot home %s before changing ownership', (kind) => {
    const home = `${getDir()}-chroot-home`;
    if (kind === 'symlink') fs.symlinkSync(getDir(), home);
    else fs.writeFileSync(home, 'not a directory');

    expect(() => prepareChrootHomeMounts({ ...baseConfig, workDir: getDir() })).toThrow();
    expect(fs.chownSync).not.toHaveBeenCalled();
  });

  it('refuses an existing root-owned .gemini symlink before repairing ownership', () => {
    const gemini = path.join(getDir(), '.gemini');
    const target = path.join(getDir(), 'gemini-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, gemini);
    // Segment creation permits root-owned system symlinks, but ownership repair
    // must not follow such a link at the .gemini leaf.
    (fs.lstatSync as jest.Mock).mockImplementation((file: fs.PathLike) => {
      const stat = actualFs.lstatSync(file);
      if (file === gemini) stat.uid = 0;
      return stat;
    });

    expect(() => prepareChrootHomeMounts({
      ...baseConfig, workDir: getDir(), geminiApiKey: 'synthetic-key',
    })).toThrow(`Refusing to use symlink as directory: ${gemini}`);
    expect(fs.chownSync).not.toHaveBeenCalledWith(gemini, expect.anything(), expect.anything());
  });

  it('still repairs ownership of an existing real .gemini directory', () => {
    const gemini = path.join(getDir(), '.gemini');
    fs.mkdirSync(gemini);
    prepareChrootHomeMounts({ ...baseConfig, workDir: getDir(), geminiApiKey: 'synthetic-key' });
    expect(fs.chownSync).toHaveBeenCalledWith(gemini, 1000, 1000);
  });
});

describe('audit copy destinations', () => {
  const { getDir } = useTempDir('awf-audit-targets-');
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    fs.mkdirSync(path.join(getDir(), 'enclave'));
    mockExecaSync.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'not present' });
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each(['directory-link', 'dangling-link', 'file'])('refuses a %s audit directory', (kind) => {
    const audit = path.join(getDir(), 'audit');
    const outside = path.join(getDir(), 'outside');
    if (kind === 'directory-link') fs.mkdirSync(outside);
    if (kind === 'file') fs.writeFileSync(audit, 'not a directory');
    else fs.symlinkSync(outside, audit);

    expect(preserveIptablesAudit(getDir(), audit)).toBe(false);
    expect(mockExecaSync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    if (kind === 'directory-link') expect(fs.readdirSync(outside)).toEqual([]);
    if (kind === 'dangling-link') expect(fs.existsSync(outside)).toBe(false);
  });

  describe.each([
    'enclave.jsonl', 'enclave-runtime.jsonl', 'enclave-host-executor.jsonl', 'enclave-agent-sessions',
  ])('%s', (name) => {
    it.each([false, true])('refuses a symlink destination (dangling: %s)', (dangling) => {
      const audit = path.join(getDir(), 'audit');
      fs.mkdirSync(audit);
      const outside = path.join(getDir(), 'outside');
      if (!dangling) {
        if (name === 'enclave-agent-sessions') fs.mkdirSync(outside);
        else fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
      }
      const destination = path.join(audit, name);
      fs.symlinkSync(outside, destination);

      expect(preserveIptablesAudit(getDir(), audit)).toBe(false);
      expect(mockExecaSync.mock.calls.some(([, args]) => args[2] === destination)).toBe(false);
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      if (dangling) expect(fs.existsSync(outside)).toBe(false);
      else if (name === 'enclave-agent-sessions') expect(fs.readdirSync(outside)).toEqual([]);
      else {
        expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
        expect(fs.statSync(outside).mode & 0o777).toBe(0o600);
      }
    });

    it('refuses the wrong destination type', () => {
      const audit = path.join(getDir(), 'audit');
      fs.mkdirSync(audit);
      const destination = path.join(audit, name);
      if (name === 'enclave-agent-sessions') fs.writeFileSync(destination, 'untouched');
      else fs.mkdirSync(destination);

      expect(preserveIptablesAudit(getDir(), audit)).toBe(false);
      expect(mockExecaSync.mock.calls.some(([, args]) => args[2] === destination)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  it('still copies each audit role and the optional sessions to a real audit directory', () => {
    const audit = path.join(getDir(), 'audit');
    fs.mkdirSync(audit);

    preserveIptablesAudit(getDir(), audit);

    expect(mockExecaSync).toHaveBeenCalledTimes(4);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
