import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { collectAgentRegressionEvidence, collectCodexRoutingEvidence } = require('./collect-agent-regression-evidence.cjs');
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
    const usage = path.join(directory, 'token-usage.jsonl');
    const record = {
      event: 'token_usage', provider: 'openai', path: '/v1/responses', status: 101,
      authorization: 'secret', model: 'secret', request_id: 'secret', input: 'private prompt',
    };
    fs.writeFileSync(usage, [
      'not json', 'null', JSON.stringify({ ...record, provider: 'anthropic' }),
      JSON.stringify({ ...record, path: '/responses?secret=hidden' }),
      JSON.stringify({ ...record, status: 'secret' }),
      JSON.stringify(record), JSON.stringify({ ...record, status: 200 }),
    ].join('\n'));
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'))).toEqual({
      source: 'api-proxy-token-usage', status: 'available', requests: [
        { transport: 'websocket', path: '/v1/responses', status: 101 },
        { transport: 'http', path: '/v1/responses', status: 200 },
      ],
    });
    expect(fs.statSync(path.join(destination, 'codex-routing.json')).mode & 0o777).toBe(0o600);
  });

  it.each(['missing', 'symlink', 'oversized', 'directory'])('does not trust %s proxy evidence', kind => {
    const usage = path.join(directory, 'token-usage.jsonl');
    if (kind === 'symlink') fs.symlinkSync(path.join(source, 'response.txt'), usage);
    if (kind === 'oversized') fs.writeFileSync(usage, Buffer.alloc(1024 * 1024 + 1));
    if (kind === 'directory') fs.mkdirSync(usage);
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    const report = JSON.parse(fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8'));
    expect(report.requests).toEqual([]);
    expect(report.status).not.toBe('available');
  });

  it('bounds the number of routing records', () => {
    const usage = path.join(directory, 'token-usage.jsonl');
    fs.writeFileSync(usage, (JSON.stringify({
      event: 'token_usage', provider: 'openai', path: '/responses', status: 200,
    }) + '\n').repeat(101));
    fs.mkdirSync(destination);
    collectCodexRoutingEvidence(usage, destination);
    const contents = fs.readFileSync(path.join(destination, 'codex-routing.json'), 'utf8');
    expect(JSON.parse(contents).requests).toHaveLength(100);
    expect(Buffer.byteLength(contents)).toBeLessThan(64 * 1024);
  });
});
