import * as fs from 'fs';
import * as path from 'path';
import {
  ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES, ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES,
  ENCLAVE_PROXY_USAGE_MAX_RECORDS, readEnclaveProxyUsage,
} from './proxy-usage';
import { persistHostExecutorProxyUsage, readHostExecutorInvocationDiagnostics } from './host-executor-journal';

describe('bounded dedicated enclave proxy usage evidence', () => {
  let root: string;
  let logs: string;
  const uid = process.getuid!();
  const gid = process.getgid!();
  const audit = 'token-tracker-audit.jsonl';
  const tokens = 'token-usage.jsonl';
  const usage = {
    event: 'token_usage', input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40,
    path: '/PRIVATE_PATH', model: 'PRIVATE_MODEL', request_id: 'PRIVATE_ID',
    payload: 'PRIVATE_PAYLOAD', authorization: 'PRIVATE_CREDENTIAL',
  };
  const write = (name: string, values: unknown[]) => fs.writeFileSync(path.join(logs, name),
    values.map(value => JSON.stringify(value) + '\n').join(''), { mode: 0o600 });
  const read = () => readEnclaveProxyUsage(logs, uid, gid);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.enclave-usage-test-'));
    logs = path.join(root, 'private-logs');
    fs.mkdirSync(logs, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('retains only request/status/token counts through private-log cleanup in a protected journal', async () => {
    write(audit, [
      { event: 'TRACK_START', status: 200, rid: 'PRIVATE_ID', path: '/PRIVATE_PATH' },
      { event: 'TRACK_END', result: 'ok', model: 'PRIVATE_MODEL' },
      { event: 'TRACK_START', status: 401 }, { event: 'TRACK_END', result: 'skip_status' },
      { event: 'WS_TRACK_START' }, { event: 'WS_TRACK_END', result: 'no_usage' },
    ]);
    write(tokens, [usage, usage]);
    // The proxy creates this file at 0644 under its private 0700 directory.
    fs.chmodSync(path.join(logs, tokens), 0o644);
    const summary = await read();
    expect(summary).toEqual({
      scope: 'run-cumulative',
      requests: {
        status: 'captured', records: 6, trackedResponses: 2, websocketSessions: 1,
        statuses: { '200': 1, '401': 1 }, results: { ok: 1, skip_status: 1, no_usage: 1 },
      },
      tokens: {
        status: 'captured', records: 2, usageRecords: 2,
        totals: { input_tokens: 20, output_tokens: 40, cache_read_tokens: 60, cache_write_tokens: 80 },
      },
    });
    const run = { runId: 'a'.repeat(32), journalDir: path.join(root, 'journal') };
    persistHostExecutorProxyUsage(run, { ...summary, ...{ payload: 'PRIVATE_PAYLOAD' } });
    fs.rmSync(logs, { recursive: true });
    const [file] = readHostExecutorInvocationDiagnostics(run);
    expect(JSON.parse(file.contents)).toMatchObject({ component: 'enclave-proxy-usage', usage: summary });
    expect(file.contents).not.toMatch(/PRIVATE_|authorization|request_id|model|payload|path/);
    expect(Buffer.byteLength(file.contents)).toBeLessThan(16 * 1024);
    expect(fs.statSync(path.join(run.journalDir, 'diagnostics')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(run.journalDir, 'diagnostics', file.name)).mode & 0o777).toBe(0o600);
  });

  it('distinguishes missing and empty evidence, never implying zero usage for absent logs', async () => {
    expect(await read()).toMatchObject({ requests: { status: 'missing' }, tokens: { status: 'missing' } });
    write(tokens, []);
    expect(await read()).toEqual({
      scope: 'run-cumulative', requests: { status: 'missing' }, tokens: { status: 'empty', records: 0 },
    });
  });

  it('keeps encoding-skip evidence without retaining the untrusted encoding text', async () => {
    write(audit, [{ event: 'TRACK_START', status: 200 },
      { event: 'TRACK_SKIP_ENCODING', ce: 'PRIVATE_ENCODING' }]);
    expect((await read()).requests).toEqual({
      status: 'captured', records: 2, trackedResponses: 1, websocketSessions: 0,
      statuses: { '200': 1 }, results: { skip_encoding: 1 },
    });
  });

  it.each(['json', 'utf8', 'partial', 'negative', 'fraction', 'overflow', 'unknown-event', 'unknown-result',
    'invalid-status'])('marks %s malformed rather than retaining partial totals', async kind => {
    write(tokens, [usage]);
    write(audit, [{ event: 'TRACK_START', status: 200 }]);
    const tokenFile = path.join(logs, tokens);
    if (kind === 'json') fs.appendFileSync(tokenFile, 'PRIVATE_INVALID\n');
    if (kind === 'utf8') fs.appendFileSync(tokenFile, Buffer.from([0xff, 0x0a]));
    if (kind === 'partial') fs.appendFileSync(tokenFile, JSON.stringify(usage));
    if (kind === 'negative') write(tokens, [{ ...usage, input_tokens: -1 }]);
    if (kind === 'fraction') write(tokens, [{ ...usage, input_tokens: 0.5 }]);
    if (kind === 'overflow') write(tokens, [{ ...usage, input_tokens: Number.MAX_SAFE_INTEGER }, usage]);
    if (kind === 'unknown-event') write(audit, [{ event: 'PRIVATE_EVENT' }]);
    if (kind === 'unknown-result') write(audit, [{ event: 'TRACK_END', result: 'PRIVATE_ERROR' }]);
    if (kind === 'invalid-status') write(audit, [{ event: 'TRACK_START', status: 999 }]);
    const summary = await read();
    const source = kind.startsWith('unknown') || kind === 'invalid-status' ? summary.requests : summary.tokens;
    expect(source).toEqual({ status: 'malformed' });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  });

  it('bounds record count and line bytes, accepting the exact boundaries', async () => {
    const line = JSON.stringify({ event: 'TRACK_END', result: 'no_usage' });
    fs.writeFileSync(path.join(logs, audit), `${line}\n`.repeat(ENCLAVE_PROXY_USAGE_MAX_RECORDS), { mode: 0o600 });
    expect((await read()).requests).toMatchObject({ status: 'captured', records: ENCLAVE_PROXY_USAGE_MAX_RECORDS });
    fs.appendFileSync(path.join(logs, audit), `${line}\n`);
    expect((await read()).requests).toEqual({ status: 'record-limit' });
    const tokenLine = JSON.stringify(usage);
    fs.writeFileSync(path.join(logs, tokens), tokenLine.padEnd(ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES) + '\n',
      { mode: 0o600 });
    expect((await read()).tokens.status).toBe('captured');
    fs.writeFileSync(path.join(logs, tokens), tokenLine.padEnd(ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES + 1) + '\n');
    expect((await read()).tokens).toEqual({ status: 'oversized' });
  });

  it('enforces a per-file byte bound without scanning arbitrary directory entries', async () => {
    const tokenLine = JSON.stringify(usage);
    const line = tokenLine.padEnd(ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES - 1) + '\n';
    fs.writeFileSync(path.join(logs, tokens), line.repeat(64), { mode: 0o600 });
    expect(fs.statSync(path.join(logs, tokens)).size).toBe(ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES);
    expect((await read()).tokens).toMatchObject({ status: 'captured', records: 64 });
    fs.appendFileSync(path.join(logs, tokens), '\n');
    expect((await read()).tokens).toEqual({ status: 'oversized' });
    fs.symlinkSync('/PRIVATE_PATH', path.join(logs, 'arbitrary-payload.jsonl'));
    expect((await read()).requests).toEqual({ status: 'missing' });
  });

  it.each(['symlink', 'hardlink', 'directory', 'mode', 'directory-mode', 'ancestor-symlink'])(
    'rejects unsafe %s without returning counts', async kind => {
      write(tokens, [usage]);
      const target = path.join(logs, tokens);
      if (kind === 'symlink') {
        fs.renameSync(target, path.join(root, 'secret'));
        fs.symlinkSync(path.join(root, 'secret'), target);
      }
      if (kind === 'hardlink') fs.linkSync(target, path.join(root, 'second-link'));
      if (kind === 'directory') {
        fs.unlinkSync(target);
        fs.mkdirSync(target, { mode: 0o600 });
      }
      if (kind === 'mode') fs.chmodSync(target, 0o666);
      if (kind === 'directory-mode') fs.chmodSync(logs, 0o755);
      if (kind === 'ancestor-symlink') {
        fs.symlinkSync(logs, path.join(root, 'alias'));
        logs = path.join(root, 'alias');
      }
      expect((await read()).tokens).toEqual({ status: 'unsafe' });
    });

  it('rejects unsafe journal ancestors and strips extra diagnostic fields at persistence', async () => {
    const run = { runId: 'a'.repeat(32), journalDir: path.join(root, 'journal') };
    fs.mkdirSync(run.journalDir, { mode: 0o700 });
    fs.symlinkSync(logs, path.join(run.journalDir, 'diagnostics'));
    expect(() => persistHostExecutorProxyUsage(run, {
      scope: 'run-cumulative', requests: { status: 'missing' }, tokens: { status: 'missing' },
    })).toThrow(/Unsafe journal ancestor/);
  });
});
