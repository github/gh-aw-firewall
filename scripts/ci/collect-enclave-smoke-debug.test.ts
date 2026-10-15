import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prepare, collect, MAX_STREAM_BYTES, MAX_FILES } = require('./collect-enclave-smoke-debug.cjs');

describe('host-only public enclave debug collector', () => {
  let temp: string;
  let run: string;
  let roots: { journal: string; debug: string };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(32);
  const vmId = createHash('sha256').update(JSON.stringify([
    'awf-host-enclave-v1', runId, 'script', invocationId,
  ])).digest('hex').slice(0, 32);

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-debug-test-'));
    run = path.join(temp, 'run');
    roots = { journal: path.join(temp, 'journal'), debug: path.join(temp, 'debug') };
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  const prepareRun = () => prepare(run, roots, uid, temp);
  function invocation() {
    fs.writeFileSync(path.join(roots.journal, `${runId}.journal`), [
      JSON.stringify({ runId, state: 'open' }),
      JSON.stringify({ invocationId, entryId: 'script', state: 'cleanup-pending' }),
    ].join('\n'), { mode: 0o600 });
    const source = path.join(roots.debug, vmId);
    fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'guest-stderr.raw.log'), 'failed guest evidence', { mode: 0o600 });
    return source;
  }
  const collectRun = () => collect(run, uid, gid, roots, uid, temp);

  it('collects a failed invocation but excludes stale directories and journals', () => {
    fs.mkdirSync(path.join(roots.debug, 'c'.repeat(32)), { mode: 0o700 });
    fs.writeFileSync(path.join(roots.journal, `${'d'.repeat(32)}.journal`), 'stale', { mode: 0o600 });
    prepareRun();
    invocation();
    for (const suffix of ['resources.json', 'diagnostics.json']) {
      fs.writeFileSync(path.join(roots.journal, `${runId}-${invocationId}.${suffix}`),
        'not uploaded', { mode: 0o600 });
    }
    expect(collectRun()).toBe(1);
    const upload = path.join(run, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual(['collection-status.txt', 'guest-stderr.raw.log']);
    const stat = fs.statSync(path.join(upload, 'guest-stderr.raw.log'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(uid);
    expect(fs.statSync(upload).mode & 0o777).toBe(0o700);
  });

  it('explicitly records an early failure with no debug logs', () => {
    prepareRun();
    expect(collectRun()).toBe(0);
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('No public-fixture debug logs were produced');
  });

  it('accepts exactly the stream size limit and rejects oversized streams without staging', () => {
    prepareRun();
    const source = invocation();
    const log = path.join(source, 'guest-stderr.raw.log');
    fs.writeFileSync(log, Buffer.alloc(MAX_STREAM_BYTES + 1));
    expect(collectRun).toThrow(/oversized/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    fs.truncateSync(log, MAX_STREAM_BYTES);
    expect(collectRun()).toBe(1);
    expect(fs.statSync(path.join(run, 'upload/guest-stderr.raw.log')).size).toBe(MAX_STREAM_BYTES);
  });

  it.each(['file-symlink', 'directory-symlink', 'hardlink', 'unknown-name', 'count', 'wrong-run',
    'traversal', 'permissions', 'journal-symlink'])('rejects %s before publishing', kind => {
    prepareRun();
    const source = invocation();
    const log = path.join(source, 'guest-stderr.raw.log');
    if (kind === 'file-symlink') {
      fs.unlinkSync(log);
      fs.symlinkSync(path.join(run, 'baseline.json'), log);
    } else if (kind === 'directory-symlink') {
      fs.renameSync(source, path.join(temp, 'moved'));
      fs.symlinkSync(path.join(temp, 'moved'), source);
    } else if (kind === 'hardlink') fs.linkSync(log, path.join(temp, 'hardlink'));
    else if (kind === 'unknown-name') fs.writeFileSync(path.join(source, 'environment.txt'), 'no', { mode: 0o600 });
    else if (kind === 'count') {
      const logNames = ['launcher-stdout.log', 'launcher-stderr.log', 'guest-stdout.raw.log',
        'cloud-hypervisor.log', 'serial.log', 'network-plan.json', 'network-diagnostics.txt',
        'counters.json', 'vm-info.json', 'runtime.json', 'confinement.json'];
      for (let i = 0; i < 8; i++) {
        for (const name of ['enclave-seed', 'enclave-request', 'enclave-output', 'enclave-runtime']) {
          logNames.push(`virtiofs-${i}-${name}`);
        }
      }
      for (const name of logNames.slice(0, MAX_FILES)) {
        fs.writeFileSync(path.join(source, name), '', { mode: 0o600 });
      }
    } else if (kind === 'wrong-run') fs.renameSync(source, path.join(roots.debug, 'e'.repeat(32)));
    else if (kind === 'traversal') {
      fs.writeFileSync(path.join(roots.journal, `${runId}.journal`), [
        JSON.stringify({ runId, state: 'open' }),
        JSON.stringify({ invocationId: '../../escape', entryId: 'script' }),
      ].join('\n'));
    } else if (kind === 'permissions') fs.chmodSync(log, 0o644);
    else if (kind === 'journal-symlink') {
      const journal = path.join(roots.journal, `${runId}.journal`);
      fs.unlinkSync(journal);
      fs.symlinkSync(path.join(run, 'baseline.json'), journal);
    }
    if (kind === 'count') expect(collectRun).toThrow(/Debug file count exceeds bound/);
    else expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });

  it('fails closed on overlapping runs and reusing the snapshot identity', () => {
    prepareRun();
    expect(prepareRun).toThrow();
    invocation();
    fs.mkdirSync(path.join(roots.debug, 'f'.repeat(32)), { mode: 0o700 });
    expect(collectRun).toThrow(/concurrent/);
  });
});
