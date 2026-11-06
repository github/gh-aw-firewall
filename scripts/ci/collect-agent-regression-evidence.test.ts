import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-require-imports */
const { collectAgentRegressionEvidence, collectCodexRoutingEvidence, collectMarkerCheck } = require('./collect-agent-regression-evidence.cjs');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('agent regression evidence collector', () => {
  let directory: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-evidence-'));
    source = path.join(directory, 'workspace', '.awf-regression', 'results');
    destination = path.join(directory, 'runner-temp', 'upload');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('stages only bounded regular evidence and redacts provider credentials', () => {
    fs.writeFileSync(path.join(source, 'agent-proof.txt'), 'unique-proof\n');
    fs.writeFileSync(path.join(source, 'agent-version.txt'), 'agent 1.0\n');
    fs.writeFileSync(path.join(source, 'response.txt'), 'response api-secret');
    fs.writeFileSync(path.join(source, 'host-file.txt'), 'must not be staged\n');
    const copied = collectAgentRegressionEvidence(source, destination, ['api-secret']);
    expect(copied.sort()).toEqual(['agent-proof.txt', 'agent-version.txt', 'response.txt']);
    expect(fs.readFileSync(path.join(destination, 'response.txt'), 'utf8'))
      .toBe('response [REDACTED]');
    expect(fs.readdirSync(destination).sort()).toEqual(copied.sort());
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
  });

  it('does not follow source-file symlinks or directory symlinks', () => {
    const outside = path.join(directory, 'outside.txt');
    fs.writeFileSync(outside, 'host secret');
    fs.symlinkSync(outside, path.join(source, 'agent-proof.txt'));
    expect(collectAgentRegressionEvidence(source, destination)).toEqual([]);
    fs.rmSync(destination, { recursive: true });
    fs.symlinkSync(path.dirname(source), path.join(directory, 'linked-workspace'));
    expect(() => collectAgentRegressionEvidence(
      path.join(directory, 'linked-workspace', '.awf-regression', 'results'),
      path.join(directory, 'runner-temp', 'second'),
    )).toThrow(/ancestor is not a real directory/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('host secret');
  });

  it('does not follow a file replaced with a symlink while opening it', () => {
    const outside = path.join(directory, 'outside.txt');
    const sourceFile = path.join(source, 'agent-proof.txt');
    fs.writeFileSync(outside, 'host secret');
    fs.writeFileSync(sourceFile, 'guest evidence');
    /* eslint-disable @typescript-eslint/no-require-imports */
    const nodeFs = require('node:fs') as typeof fs;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const originalOpenSync = nodeFs.openSync;
    const openSpy = jest.spyOn(nodeFs, 'openSync').mockImplementation((...args) => {
      if (args[0] === sourceFile) {
        fs.unlinkSync(sourceFile);
        fs.symlinkSync(outside, sourceFile);
      }
      return originalOpenSync(...args);
    });

    try {
      expect(collectAgentRegressionEvidence(source, destination)).toEqual([]);
      expect(fs.readdirSync(destination)).toEqual([]);
      expect(fs.readFileSync(outside, 'utf8')).toBe('host secret');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('rejects oversized evidence instead of staging it', () => {
    fs.writeFileSync(path.join(source, 'response.txt'), randomBytes(64 * 1024 + 1));
    expect(collectAgentRegressionEvidence(source, destination)).toEqual([]);
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('projects only fixed routing fields for both Codex transports', () => {
    const usage = path.join(directory, 'token-tracker-audit.jsonl');
    const record = {
      ts: 123, rid: 'secret', event: 'WS_UPSTREAM_RESPONSE', provider: 'openai', path: '/v1/responses', status: 101,
      authorization: 'secret', model: 'secret', request_id: 'secret', input: 'private prompt',
    };
    fs.writeFileSync(usage, [
      'not json', 'null', JSON.stringify({ ...record, provider: 'anthropic' }),
      JSON.stringify({ ...record, path: '/models?secret=hidden' }),
      JSON.stringify({ ...record, status: 'secret' }),
      JSON.stringify(record), JSON.stringify({ ...record, event: 'TRACK_START', status: 200 }),
      '',
    ].join('\n'));
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    const report = JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'));
    expect(report).toMatchObject({
      source: 'api-proxy-token-tracker-audit', status: 'successful', requests: [
        { transport: 'websocket', path: '/v1/responses', status: 101 },
        { transport: 'http', path: '/v1/responses', status: 200 },
      ],
    });
    expect(report.diagnostics).toMatchObject({
      malformed: 1, wrongSource: 1, wrongProvider: 1, wrongPath: 1, invalidStatus: 1,
    });
    expect(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8')).not.toMatch(/secret|private prompt/);
    expect(fs.statSync(path.join(destination, 'codex-routing.json')).mode & 0o777).toBe(0o600);
  });

  it.each(['missing', 'symlink', 'oversized', 'directory'])('does not trust %s proxy evidence', kind => {
    const usage = path.join(directory, 'token-tracker-audit.jsonl');
    if (kind === 'symlink') fs.symlinkSync(path.join(source, 'response.txt'), usage);
    if (kind === 'oversized') fs.writeFileSync(usage, Buffer.alloc(1024 * 1024 + 1));
    if (kind === 'directory') fs.mkdirSync(usage);
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    const report = JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'));
    expect(report.requests).toEqual([]);
    expect(report.status).toBe(kind === 'missing' ? 'unavailable' : 'rejected');
  });

  it('bounds the number of routing records', () => {
    const usage = path.join(directory, 'token-tracker-audit.jsonl');
    fs.writeFileSync(usage, (JSON.stringify({
      ts: 123, rid: 'http', event: 'TRACK_START', provider: 'openai', path: '/responses', status: 200,
    }) + '\n').repeat(101));
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    const contents = fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8');
    expect(JSON.parse(contents).requests).toHaveLength(100);
    expect(JSON.parse(contents).diagnostics.truncated).toBe(true);
    expect(Buffer.byteLength(contents)).toBeLessThan(64 * 1024);
  });

  it.each([
    { contents: '', status: 'empty', diagnostics: { partialLine: false } },
    { contents: '{"event":"TRACK_START"', status: 'rejected', diagnostics: { partialLine: true } },
    { contents: '{"event":"token_usage","provider":"openai","path":"/v1/responses","status":200}\n',
      status: 'rejected', diagnostics: { wrongSource: 1 } },
    { contents: '{"ts":123,"rid":"x","event":"TRACK_START","provider":"openai","path":"/models","status":200}\n',
      status: 'empty', diagnostics: { wrongPath: 1 } },
    { contents: '{"ts":123,"rid":"x","event":"TRACK_START","provider":"openai","path":"/v1/responses","status":401}\n',
      status: 'failed', diagnostics: { pending: 1 } },
    { contents: '{"ts":123,"rid":"x","event":"WS_TRACK_START","provider":"openai","path":"/v1/responses"}\n',
      status: 'empty', diagnostics: { pending: 1 } },
  ])('classifies $status telemetry without trusting it as routing success', ({ contents, status, diagnostics }) => {
    const audit = path.join(directory, 'token-tracker-audit.jsonl');
    fs.writeFileSync(audit, contents);
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(audit, destination);
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8')))
      .toMatchObject({ status, diagnostics });
  });

  it.each([
    { output: '\nAWF-REGRESSION-COMPLETE\n', completion: 'match-lf' },
    { output: '\r\nAWF-REGRESSION-COMPLETE\r\nNVX-SANDBOX-EXIT: status=0\r\n', completion: 'match-crlf' },
    { output: '\nAWF-REGRESSION-COMPLETE', completion: 'unterminated' },
    { output: '\nAWF-REGRESSION-COMPLET\n', completion: 'partial' },
    { output: '\nclaimed AWF-REGRESSION-COMPLETE\r\n', completion: 'embedded-or-decorated' },
    { output: '\n\u001b[?25hAWF-REGRESSION-COMPLETE\n', completion: 'embedded-or-decorated' },
    { output: '\nAWF-REGRESSION-COMPLETE\r\r\n', completion: 'embedded-or-decorated' },
    { output: '\nAWF-REGRESSION-\nCOMPLETE\n', completion: 'missing' },
    { output: '\n', completion: 'missing' },
  ])('retains only the bounded $completion marker classification', ({ output, completion }) => {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'agent-proof.txt'), 'expected\n\n');
    fs.writeFileSync(path.join(destination, 'response.txt'), 'expected\n');
    const log = path.join(directory, 'awf.log');
    fs.writeFileSync(log, `private-secret\n${output}`);
    collectMarkerCheck(log, destination, 'expected');
    const report = fs.readFileSync(path.join(destination, 'marker-check.json'), 'utf8');
    expect(JSON.parse(report)).toEqual({ proof: 'match', response: 'match', completion });
    expect(report).not.toContain('private-secret');
    expect(Buffer.byteLength(report)).toBeLessThan(200);
    expect(fs.statSync(path.join(destination, 'marker-check.json')).mode & 0o777).toBe(0o600);
  });

  it('distinguishes response mismatch from a rejected host log without logging either', () => {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'response.txt'), 'expected\u0000\n');
    const log = path.join(directory, 'awf.log');
    fs.writeFileSync(log, Buffer.alloc(16 * 1024 * 1024 + 1));
    collectMarkerCheck(log, destination, 'expected');
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'marker-check.json'), 'utf8')))
      .toEqual({ proof: 'missing', response: 'mismatch', completion: 'rejected' });
  });

  it.each([
    { header: 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n', status: 'successful' },
    { header: 'HTTP/1.1 401 Unauthorized\r\n\r\n', status: 'failed' },
    { header: 'HTTP/1.1 101 Switching', status: 'empty' },
    { header: 'fabricated HTTP/1.1 101 Switching Protocols\r\n\r\n', status: 'rejected' },
    { header: '', status: 'empty' },
  ])('collects real WebSocket producer evidence on transport close: $status', ({ header, status }) => {
    const producer = path.resolve(__dirname, '../../containers/api-proxy/token-tracker-ws.js');
    const persistence = path.resolve(__dirname, '../../containers/api-proxy/token-persistence.js');
    const result = spawnSync(process.execPath, ['-e', `
      const { EventEmitter } = require('events');
      const { trackWebSocketTokenUsage } = require(${JSON.stringify(producer)});
      const { closeLogStream } = require(${JSON.stringify(persistence)});
      const socket = new EventEmitter();
      trackWebSocketTokenUsage(socket, {
        requestId: 'fixture', provider: 'openai', path: '/v1/responses',
        startTime: Date.now(), metrics: { increment() {} },
      });
      const header = Buffer.from(${JSON.stringify(header)});
      for (const byte of header) socket.emit('data', Buffer.from([byte]));
      socket.emit('end');
      socket.emit('close');
      closeLogStream().catch(() => { process.exitCode = 1; });
    `], { env: { ...process.env, AWF_TOKEN_LOG_DIR: directory, AWF_VERSION: '0.0.0-test' }, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(path.join(directory, 'token-usage.jsonl'), 'utf8')).toBe('');
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(path.join(directory, 'token-tracker-audit.jsonl'), destination);
    const report = JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'));
    expect(report.status).toBe(status);
    expect(report.diagnostics).toMatchObject({ noUsage: 1, starts: 1, ends: 1, pending: 0 });
    expect(report.requests).toHaveLength(header.includes('\r\n\r\n') && status !== 'rejected' ? 1 : 0);
  });

  it.each(['end', 'close'])('collects real HTTP no-usage evidence finalized by %s', event => {
    const producer = path.resolve(__dirname, '../../containers/api-proxy/token-tracker-http.js');
    const persistence = path.resolve(__dirname, '../../containers/api-proxy/token-persistence.js');
    const result = spawnSync(process.execPath, ['-e', `
      const { EventEmitter } = require('events');
      const { trackTokenUsage } = require(${JSON.stringify(producer)});
      const { closeLogStream } = require(${JSON.stringify(persistence)});
      const response = new EventEmitter();
      response.headers = { 'content-type': 'text/event-stream' };
      response.statusCode = 200;
      const client = new EventEmitter();
      trackTokenUsage(response, {
        requestId: 'fixture', provider: 'openai', path: '/v1/responses',
        startTime: Date.now(), metrics: { increment() {} }, res: client,
      });
      response.emit('data', Buffer.from('data: {"type":"response.completed","response":{"status":"completed"}}\\n\\n'));
      ${event === 'close' ? 'client' : 'response'}.emit(${JSON.stringify(event)});
      response.emit('end');
      closeLogStream().catch(() => { process.exitCode = 1; });
    `], { env: { ...process.env, AWF_TOKEN_LOG_DIR: directory, AWF_VERSION: '0.0.0-test' }, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(path.join(directory, 'token-usage.jsonl'), 'utf8')).toBe('');
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(path.join(directory, 'token-tracker-audit.jsonl'), destination);
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'))).toMatchObject({
      status: 'successful', requests: [{ transport: 'http', path: '/v1/responses', status: 200 }],
      diagnostics: { starts: 1, ends: 1, pending: 0, noUsage: 1 },
    });
  });
});
