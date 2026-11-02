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
    (fs.fchownSync as jest.Mock).mockReset();
  });

  afterEach(() => {
    fs.rmSync(`${getDir()}-chroot-home`, { recursive: true, force: true });
    fs.rmSync(`${getDir()}-chroot-home-moved`, { recursive: true, force: true });
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
    const changedInodes: number[] = [];
    (fs.fchownSync as jest.Mock).mockImplementation((fd: number) => {
      changedInodes.push(actualFs.fstatSync(fd).ino);
    });
    // Segment creation permits root-owned system symlinks, but ownership repair
    // must not follow such a link at the .gemini leaf.
    (fs.lstatSync as jest.Mock).mockImplementation((file: fs.PathLike) => {
      const stat = actualFs.lstatSync(file);
      if (file === gemini) stat.uid = 0;
      return stat;
    });

    expect(() => prepareChrootHomeMounts({
      ...baseConfig, workDir: getDir(), geminiApiKey: 'synthetic-key',
    })).toThrow();
    expect(changedInodes).not.toContain(actualFs.statSync(target).ino);
  });

  it('still repairs ownership of an existing real .gemini directory', () => {
    const gemini = path.join(getDir(), '.gemini');
    fs.mkdirSync(gemini);
    const geminiInode = actualFs.statSync(gemini).ino;
    const changedInodes: number[] = [];
    (fs.fchownSync as jest.Mock).mockImplementation((fd: number) => {
      changedInodes.push(actualFs.fstatSync(fd).ino);
    });
    prepareChrootHomeMounts({ ...baseConfig, workDir: getDir(), geminiApiKey: 'synthetic-key' });
    expect(changedInodes).toContain(geminiInode);
  });

  it('keeps chroot-home mountpoint creation pinned if the home path is replaced after opening', () => {
    const home = `${getDir()}-chroot-home`;
    const movedHome = `${home}-moved`;
    const outside = path.join(getDir(), 'outside-home');
    fs.mkdirSync(home);
    fs.mkdirSync(outside);
    const originalInode = actualFs.statSync(home).ino;
    let replaced = false;
    (fs.fchownSync as jest.Mock).mockImplementation((fd: number) => {
      if (!replaced && actualFs.fstatSync(fd).ino === originalInode) {
        actualFs.renameSync(home, movedHome);
        actualFs.symlinkSync(outside, home);
        replaced = true;
      }
    });

    expect(() => prepareChrootHomeMounts({ ...baseConfig, workDir: getDir() })).not.toThrow();
    expect(replaced).toBe(true);
    expect(fs.lstatSync(home).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(movedHome, '.cache'))).toBe(true);
  });

  it('keeps Gemini ownership pinned if its path is replaced after opening', () => {
    const gemini = path.join(getDir(), '.gemini');
    const movedGemini = `${gemini}-moved`;
    const outside = path.join(getDir(), 'outside-gemini');
    fs.mkdirSync(gemini);
    fs.mkdirSync(outside);
    const geminiInode = actualFs.statSync(gemini).ino;
    let replaced = false;
    (fs.fchownSync as jest.Mock).mockImplementation((fd: number) => {
      if (!replaced && actualFs.fstatSync(fd).ino === geminiInode) {
        actualFs.renameSync(gemini, movedGemini);
        actualFs.symlinkSync(outside, gemini);
        replaced = true;
      }
    });

    expect(() => prepareChrootHomeMounts({
      ...baseConfig, workDir: getDir(), geminiApiKey: 'synthetic-key',
    })).not.toThrow();
    expect(replaced).toBe(true);
    expect(fs.lstatSync(gemini).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
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

  it('refuses an audit directory beneath a symlinked ancestor', () => {
    const target = path.join(getDir(), 'target');
    const alias = path.join(getDir(), 'alias');
    fs.mkdirSync(path.join(target, 'audit'), { recursive: true });
    fs.symlinkSync(target, alias);

    expect(preserveIptablesAudit(getDir(), path.join(alias, 'audit'))).toBe(false);
    expect(mockExecaSync).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(target, 'audit'))).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
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

  it('publishes staged copies to the opened audit directory if its path is replaced', () => {
    const audit = path.join(getDir(), 'audit');
    const movedAudit = path.join(getDir(), 'audit-moved');
    const outside = path.join(getDir(), 'outside-audit');
    fs.mkdirSync(audit);
    fs.mkdirSync(outside);
    mockExecaSync.mockImplementationOnce((_command, args) => {
      actualFs.renameSync(audit, movedAudit);
      actualFs.symlinkSync(outside, audit);
      actualFs.writeFileSync(args[2] as string, 'staged audit');
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    preserveIptablesAudit(getDir(), audit);

    expect(fs.readFileSync(path.join(movedAudit, 'enclave.jsonl'), 'utf8')).toBe('staged audit');
    expect(fs.lstatSync(audit).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
