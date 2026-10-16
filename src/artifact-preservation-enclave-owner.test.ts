import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { handoffPrivateEnclaveAudit } from './artifact-preservation';

const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;

(linuxRoot ? describe : describe.skip)('private enclave audit Linux runner handoff', () => {
  let root: string;
  let file: string;
  const previousUid = process.env.SUDO_UID;
  const previousGid = process.env.SUDO_GID;
  const runner = 12345;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-owner-'));
    fs.chownSync(root, runner, runner);
    file = path.join(root, 'enclave-host-executor.jsonl');
    fs.writeFileSync(file, '{"reason":"PRIVATE_SENTINEL"}\n', { mode: 0o600 });
    process.env.SUDO_UID = String(runner);
    process.env.SUDO_GID = String(runner);
  });
  afterEach(() => {
    if (previousUid === undefined) delete process.env.SUDO_UID;
    else process.env.SUDO_UID = previousUid;
    if (previousGid === undefined) delete process.env.SUDO_GID;
    else process.env.SUDO_GID = previousGid;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function redact() {
    return spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      try {
        const text = fs.readFileSync(process.argv[1], 'utf8');
        fs.writeFileSync(process.argv[1], text.replace('PRIVATE_SENTINEL', '[REDACTED]'));
      } catch (error) {
        process.stderr.write(error.code);
        process.exit(1);
      }
    `, file], { uid: runner, gid: runner, encoding: 'utf8' });
  }
  it('reproduces read EACCES then permits non-root redaction without widening 0600', () => {
    expect(redact()).toMatchObject({ status: 1, stderr: 'EACCES' });
    handoffPrivateEnclaveAudit(root);
    expect(redact()).toMatchObject({ status: 0, stderr: '' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"reason":"[REDACTED]"}\n');
    expect(fs.statSync(file)).toMatchObject({ uid: runner, gid: runner });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(spawnSync(process.execPath, ['-e', `
      try { require('fs').readFileSync(process.argv[1]); process.exit(1); }
      catch (error) { process.exit(error.code === 'EACCES' ? 0 : 2); }
    `, file], { uid: runner + 1, gid: runner + 1 }).status).toBe(0);
  });
  it.each(['symlink', 'hardlink', 'public-mode', 'oversize', 'wrong-owner', 'ancestor-symlink'])(
    'rejects %s without handing off the source', kind => {
      if (kind === 'symlink') {
        fs.renameSync(file, path.join(root, 'outside'));
        fs.symlinkSync(path.join(root, 'outside'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'linked'));
      else if (kind === 'public-mode') fs.chmodSync(file, 0o644);
      else if (kind === 'oversize') fs.truncateSync(file, 32 * 1024 * 1024 + 1);
      else if (kind === 'wrong-owner') fs.chownSync(file, runner + 1, runner + 1);
      else {
        fs.mkdirSync(path.join(root, 'target'));
        fs.symlinkSync(path.join(root, 'target'), path.join(root, 'alias'));
      }
      expect(() => handoffPrivateEnclaveAudit(kind === 'ancestor-symlink'
        ? path.join(root, 'alias') : root)).toThrow();
    },
  );
});
