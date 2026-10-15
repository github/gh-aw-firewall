import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  exportResolvedConfigPath, openArtifactDirectory, publishEarlyResolvedConfig,
  publishFinalResolvedConfig,
} from './resolved-config-artifact';
import { preserveIptablesAudit } from './artifact-preservation';
import { testHelpers } from './commands/main-action';
import { MAIN_ACTION_STUB_CONFIG } from './commands/main-action.test-utils';

jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual('fs') }));

const describeRootLinux = process.platform === 'linux' && process.getuid?.() === 0 ? describe : describe.skip;

describeRootLinux('real Linux root-to-runner config publication', () => {
  let directory: string;
  let publications: string[];
  const environment = { ...process.env };
  beforeEach(() => {
    directory = fs.mkdtempSync('/tmp/awf-publication-test-');
    publications = [];
    process.env.SUDO_UID = '500';
    process.env.SUDO_GID = '20';
    delete process.env.GITHUB_ENV;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const file of publications) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    process.env = { ...environment };
  });

  const asRunner = (code: string, args: string[] = [], uid = 500, gid = 20) => {
    const result = spawnSync(process.execPath, ['-e', code, ...args], { uid, gid, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    return result;
  };
  const publish = () => {
    const file = publishEarlyResolvedConfig('{"redacted":true}\n');
    publications.push(file);
    return file;
  };

  it.each([[0, 0], [500, 20], [1001, 1002]])(
    'allows actual caller %i:%i to read, rewrite, replace and remove without opening private state', (uid, gid) => {
      process.env.SUDO_UID = String(uid);
      process.env.SUDO_GID = String(gid);
      // Neither a private workDir nor arbitrarily nested custom audit parents
      // participate in early publication.
      const workDir = path.join(directory, 'private-work');
      const nested = path.join(workDir, 'missing', 'nested', 'audit');
      fs.mkdirSync(workDir, { mode: 0o700 });
      fs.writeFileSync(path.join(workDir, 'recovery'), 'PRIVATE_SENTINEL', { mode: 0o600 });
      const file = publish();
      expect(file.startsWith('/run/awf-config-audit/run-')).toBe(true);
      expect(fs.existsSync(nested)).toBe(false);
      expect(fs.statSync(workDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).uid).toBe(uid);
      expect(fs.statSync(file).gid).toBe(gid);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(asRunner("require('fs').readFileSync(process.argv[1])", [file], 1000, 1000).status).not.toBe(0);
      const result = asRunner(`
        const fs = require('fs'), p = process.argv[1];
        if (!fs.readFileSync(p, 'utf8').includes('redacted')) process.exit(2);
        fs.writeFileSync(p, 'rewritten');
        fs.writeFileSync(p + '.replacement', 'replacement', { mode: 0o600 });
        fs.renameSync(p + '.replacement', p);
        fs.unlinkSync(p);
      `, [file], uid, gid);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      if (uid !== 0) {
        expect(asRunner("require('fs').readFileSync(process.argv[1])",
          [path.join(workDir, 'recovery')], uid, gid).status).not.toBe(0);
      }
    },
  );

  it('exports a path to the real parent runner environment file before cleanup', () => {
    const env = path.join(directory, 'github-env');
    fs.writeFileSync(env, '', { mode: 0o600 });
    fs.chownSync(env, 500, 20);
    process.env.GITHUB_ENV = env;
    const file = publish();
    exportResolvedConfigPath(file);
    expect(fs.readFileSync(env, 'utf8')).toBe(`AWF_RESOLVED_CONFIG=${file}\n`);
  });

  it('rejects environment injection and linked command files without widening permissions', () => {
    const env = path.join(directory, 'github-env');
    fs.writeFileSync(env, '', { mode: 0o600 });
    fs.chownSync(env, 500, 20);
    process.env.GITHUB_ENV = env;
    const file = publish();
    expect(() => exportResolvedConfigPath(`${file}\nINJECTED=value`)).toThrow('Invalid resolved config');
    expect(fs.readFileSync(env, 'utf8')).toBe('');
    const link = path.join(directory, 'env-link');
    fs.symlinkSync(env, link);
    process.env.GITHUB_ENV = link;
    expect(() => exportResolvedConfigPath(file)).toThrow();
    fs.unlinkSync(link);
    fs.linkSync(env, link);
    expect(() => exportResolvedConfigPath(file)).toThrow('Unsafe GitHub environment file');
    expect(fs.readFileSync(env, 'utf8')).toBe('');
    expect(fs.statSync(env).mode & 0o777).toBe(0o600);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  });

  it.each(['default', 'nested', 'symlink'])(
    'publishes the production startup diagnostic with %s audit configuration without touching private parents', (kind) => {
      const privateWork = path.join(directory, 'work');
      fs.mkdirSync(privateWork, { mode: 0o700 });
      const target = path.join(directory, 'target');
      fs.mkdirSync(target, { mode: 0o700 });
      const alias = path.join(directory, 'alias');
      fs.symlinkSync(target, alias);
      const auditDir = kind === 'default' ? undefined
        : kind === 'nested' ? path.join(privateWork, 'missing', 'audit') : `${alias}/.`;
      const env = path.join(directory, 'github-env');
      fs.writeFileSync(env, '', { mode: 0o600 });
      fs.chownSync(env, 500, 20);
      process.env.GITHUB_ENV = env;
      testHelpers.persistConfigAuditArtifact(
        { ...MAIN_ACTION_STUB_CONFIG, workDir: privateWork, auditDir }, { state: 'preflight' },
      );
      const file = fs.readFileSync(env, 'utf8').trim().slice('AWF_RESOLVED_CONFIG='.length);
      publications.push(file);
      expect(file.startsWith('/run/awf-config-audit/run-')).toBe(true);
      expect(asRunner("if (!require('fs').readFileSync(process.argv[1], 'utf8').includes('preflight')) process.exit(1)",
        [file]).status).toBe(0);
      expect(fs.readdirSync(privateWork)).toEqual([]);
      expect(fs.readdirSync(target)).toEqual([]);
      expect(fs.statSync(privateWork).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
      expect(fs.statSync(target).uid).toBe(0);
    },
  );

  it('rejects malformed identity before any filesystem operation', () => {
    process.env.SUDO_UID = '-1';
    const open = jest.spyOn(fs, 'openSync');
    expect(publish).toThrow('Invalid sudo artifact identity');
    expect(open).not.toHaveBeenCalled();
  });

  it('preserves exclusive file and directory modes even with a restrictive umask', () => {
    const old = process.umask(0o777);
    try {
      const file = publish();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(old);
    }
  });

  it('preserves a fresh iptables dump without handing the shared directory to the runner', () => {
    const audit = path.join(directory, 'audit');
    fs.mkdirSync(audit);
    fs.mkdirSync(path.join(directory, 'init-signal'));
    fs.writeFileSync(path.join(directory, 'init-signal', 'iptables-audit.txt'), 'rules');
    expect(preserveIptablesAudit(directory, audit)).toBe(true);
    expect(fs.readFileSync(path.join(audit, 'iptables-audit.txt'), 'utf8')).toBe('rules');
    expect(fs.statSync(audit).uid).toBe(0);
    expect(fs.statSync(path.join(audit, 'iptables-audit.txt')).mode & 0o777).toBe(0o644);
  });

  it.each(['ancestor', 'leaf', 'leaf/', 'leaf/.', 'leaf/..', 'leaf//child'])(
    'rejects symlinks or ambiguous spelling %s without changing target ownership, modes or entries', (spelling) => {
      const target = path.join(directory, 'target');
      fs.mkdirSync(target, { mode: 0o700 });
      fs.mkdirSync(path.join(target, 'audit'));
      fs.symlinkSync(target, path.join(directory, 'ancestor'));
      fs.symlinkSync(target, path.join(directory, 'leaf'));
      const destination = spelling === 'ancestor'
        ? `${directory}/ancestor/audit` : `${directory}/${spelling}`;
      expect(() => publishFinalResolvedConfig(destination, 'config')).toThrow();
      expect(fs.statSync(target).uid).toBe(0);
      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(target)).toEqual(['audit']);
    },
  );

  it.each(['symlink', 'hardlink', 'existing'])('never overwrites a pre-existing %s final artifact', (kind) => {
    const target = path.join(directory, 'target');
    fs.writeFileSync(target, 'UNCHANGED', { mode: 0o600 });
    const audit = path.join(directory, 'audit');
    fs.mkdirSync(audit);
    const destination = path.join(audit, 'awf-resolved-config.json');
    if (kind === 'symlink') fs.symlinkSync(target, destination);
    if (kind === 'hardlink') fs.linkSync(target, destination);
    if (kind === 'existing') fs.writeFileSync(destination, 'EXISTING');
    expect(() => publishFinalResolvedConfig(audit, 'config')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('UNCHANGED');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(target).uid).toBe(0);
  });

  it('pins the opened directory across replacement instead of following a replacement symlink', () => {
    const audit = path.join(directory, 'audit');
    const target = path.join(directory, 'target');
    fs.mkdirSync(audit);
    fs.mkdirSync(target);
    const fd = openArtifactDirectory(audit);
    try {
      fs.renameSync(audit, `${audit}-moved`);
      fs.symlinkSync(target, audit);
      const fileFd = fs.openSync(`/proc/self/fd/${fd}/proof`, 'wx');
      fs.closeSync(fileFd);
      expect(fs.readdirSync(target)).toEqual([]);
      expect(fs.readdirSync(`${audit}-moved`)).toEqual(['proof']);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('anchors actual final creation when an ancestor is replaced mid-walk', () => {
    const ancestor = path.join(directory, 'ancestor');
    const audit = path.join(ancestor, 'audit');
    const target = path.join(directory, 'target');
    fs.mkdirSync(audit, { recursive: true });
    fs.mkdirSync(path.join(target, 'audit'), { recursive: true });
    const open = fs.openSync;
    let swapped = false;
    jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (!swapped && String(file).endsWith('/ancestor')) {
        swapped = true;
        fs.renameSync(ancestor, `${ancestor}-moved`);
        fs.symlinkSync(target, ancestor);
      }
      return fd;
    });
    publishFinalResolvedConfig(audit, 'config');
    expect(swapped).toBe(true);
    expect(fs.readdirSync(path.join(target, 'audit'))).toEqual([]);
    expect(fs.readFileSync(path.join(`${ancestor}-moved`, 'audit', 'awf-resolved-config.json'), 'utf8')).toBe('config');
  });

  it.each(['symlink', 'hardlink'])('blocks the cleanup iptables %s overwrite even in a runner-owned audit dir', (kind) => {
    const audit = path.join(directory, 'audit');
    const target = path.join(directory, 'target');
    fs.mkdirSync(audit);
    fs.chownSync(audit, 500, 20);
    fs.writeFileSync(target, 'UNCHANGED', { mode: 0o600 });
    fs.mkdirSync(path.join(directory, 'init-signal'));
    fs.writeFileSync(path.join(directory, 'init-signal', 'iptables-audit.txt'), 'rules');
    const destination = path.join(audit, 'iptables-audit.txt');
    if (kind === 'symlink') fs.symlinkSync(target, destination);
    else fs.linkSync(target, destination);
    expect(preserveIptablesAudit(directory, audit)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('UNCHANGED');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});
