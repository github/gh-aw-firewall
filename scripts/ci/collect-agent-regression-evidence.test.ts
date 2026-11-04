import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { collectAgentRegressionEvidence } = require('./collect-agent-regression-evidence.cjs');
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
});
