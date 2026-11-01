import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { withInputPreflight } from './input-preflight';

describe('sandbox input preflight', () => {
  let root: string;
  let input: string;

  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/awf-input-preflight-');
    fs.chmodSync(root, 0o755);
    input = path.join(root, 'inputs');
    fs.mkdirSync(input, { mode: 0o755 });
    fs.writeFileSync(path.join(input, 'output.json'), '{"private":"input-content"}', { mode: 0o644 });
  });

  afterEach(() => {
    fs.chmodSync(input, 0o700);
    fs.chmodSync(path.join(input, 'output.json'), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(dirs = [input], command = 'printf scanned', env = process.env) {
    return spawnSync('/bin/sh', ['-c', withInputPreflight(command, dirs)], {
      encoding: 'utf8',
      env,
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    });
  }

  it('does not alter commands without declared inputs', () => {
    expect(withInputPreflight('exit 7')).toBe('exit 7');
    expect(withInputPreflight('exit 7', [])).toBe('exit 7');
  });

  it('runs the command after reading nested inputs without leaking their contents', () => {
    fs.mkdirSync(path.join(input, 'nested'));
    fs.writeFileSync(path.join(input, 'nested', 'prompt.txt'), 'private-prompt');
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('scanned');
    expect(result.stderr).toBe('');
    expect(run([input], 'exit 7').status).toBe(7);
  });

  it.each([false, true])('batches full reads and propagates read failures (failure=%s)', (failure) => {
    fs.writeFileSync(path.join(input, 'file with spaces'), 'private-content');
    fs.writeFileSync(path.join(input, '-file\nwith newline'), 'private-content');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'cat'),
      `#!/bin/sh
printf 'cat arguments: %s\\n' "$#" >&2
/bin/cat "$@" || exit 1
exit ${failure ? 1 : 0}
`,
      { mode: 0o755 }
    );

    const result = run([input], 'printf scanned', { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(failure ? 1 : 0);
    expect(result.stdout).toBe(failure ? '' : 'scanned');
    expect(result.stderr.match(/cat arguments: \d+/g)).toEqual(['cat arguments: 4']);
    if (failure) expect(result.stderr).toContain('AWF input preflight failed');
  });

  it.each(['missing', 'empty', 'unreadable-directory', 'untraversable-directory', 'unreadable-file'])(
    'fails closed on %s inputs before executing the detector',
    (state) => {
      let dirs = [input];
      if (state === 'missing') dirs = [path.join(root, 'missing')];
      if (state === 'empty') {
        const empty = path.join(root, 'empty');
        fs.mkdirSync(empty);
        dirs = [empty];
      }
      if (state === 'unreadable-directory') fs.chmodSync(input, 0);
      if (state === 'untraversable-directory') fs.chmodSync(input, 0o400);
      if (state === 'unreadable-file') fs.chmodSync(path.join(input, 'output.json'), 0);

      const result = run(dirs);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('AWF input preflight failed');
    }
  );

  it('checks every declared directory', () => {
    const result = run([input, path.join(root, 'missing')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('fails closed on broken symlinks and symlink loops', () => {
    fs.symlinkSync(path.join(root, 'missing'), path.join(input, 'link'));
    expect(run().status).toBe(1);
    fs.unlinkSync(path.join(input, 'link'));
    fs.symlinkSync(input, path.join(input, 'link'));
    expect(run().status).toBe(1);
  });

  it('quotes input paths rather than interpreting shell syntax', () => {
    const unusual = path.join(root, "input'$(printf injected)");
    fs.mkdirSync(unusual);
    fs.writeFileSync(path.join(unusual, 'input'), 'data');
    const result = run([unusual]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('scanned');
  });
});
