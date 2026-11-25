import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'node:child_process';
import * as yaml from 'js-yaml';
import { Script } from 'node:vm';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

const { runCheck } = require('../../.github/workflows/shared/check-codex-playwright.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/smoke-codex.md'), 'utf8');
const workflow = yaml.load(source.split('---')[1]) as { 'post-steps': { name: string; run: string }[] };
const validator = workflow['post-steps'].find(step => step.name === 'Validate Playwright title check')!.run;

function verifyResult(resultDir: string) {
  const code = validator.replace(/^node <<'NODE'\n/, '').replace(/\nNODE\s*$/, '');
  new Script(code).runInNewContext({
    require: (name: string) => {
      if (name !== 'node:fs') throw new Error(`Unexpected import: ${name}`);
      return fs;
    },
    process: {
      env: { RESULT_FILE: path.join(resultDir, 'result.json') },
      exit: (status: number) => { throw new Error(`Validator exited ${status}`); },
    },
    console: { error: jest.fn() },
  }, { timeout: 1000 });
}

describe('Codex Playwright title check', () => {
  let resultDir: string;
  const spawn = childProcess.spawnSync as jest.Mock;
  let originalProxy: string | undefined;

  beforeEach(() => {
    resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-playwright-'));
    originalProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://172.30.0.10:3128';
    spawn.mockReset();
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, signal: null, pid: 1, output: [],
      stdout: args?.includes('eval') ? '"GitHub · Build and ship software"' : '',
      stderr: '',
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    jest.restoreAllMocks();
    fs.rmSync(resultDir, { recursive: true, force: true });
  });

  it('uses provisioned Chromium, explicit smoke-only sandbox options, and the AWF proxy', () => {
    runCheck(resultDir);
    const config = JSON.parse(fs.readFileSync(path.join(resultDir, 'cli.config.json'), 'utf8'));
    expect(config.browser).toEqual({
      browserName: 'chromium', isolated: true,
      launchOptions: {
        headless: true, chromiumSandbox: false,
        proxy: { server: 'http://172.30.0.10:3128', bypass: 'localhost,127.0.0.1' },
      },
    });
    expect(spawn.mock.calls[0][1]).toEqual([
      expect.stringMatching(/^-s=codex-smoke-/), 'open', '--browser=chromium',
      `--config=${path.join(resultDir, 'cli.config.json')}`, 'https://github.com',
    ]);
    expect(spawn.mock.calls[1][1]).toContain('() => document.title');
    expect(spawn.mock.calls[2][1]).toEqual([spawn.mock.calls[0][1][0], 'close']);
    expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 90000 });
    expect(() => verifyResult(resultDir)).not.toThrow();
  });

  it.each([
    ['SUID launch failure', 1, 'The SUID sandbox helper binary was found'],
    ['launch timeout', null, ''],
  ])('fails closed on %s and removes stale success evidence', (_name, status, stderr) => {
    fs.writeFileSync(path.join(resultDir, 'result.json'), '{"status":"PASS","title":"GitHub"}');
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: args.includes('open') ? status : 0, stdout: '', stderr, signal: null,
    }));
    expect(() => runCheck(resultDir)).toThrow('Playwright title check failed');
    expect(() => verifyResult(resultDir)).toThrow();
    expect(spawn.mock.calls.some(([, args]) => args.includes('close'))).toBe(true);
  });

  it.each([
    ['wrong title', '"Example Domain"'],
    ['zero-exit tool error', '### Error\nGitHub navigation failed'],
    ['non-string result', '{"title":"GitHub"}'],
  ])('does not accept %s as a title result', (_name, stdout) => {
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, stdout: args.includes('eval') ? stdout : '', stderr: '', signal: null,
    }));
    expect(() => runCheck(resultDir)).toThrow('Playwright title check failed');
    expect(() => verifyResult(resultDir)).toThrow();
  });

  it.each(['', '{}', 'not json', '{"status":"FAIL","title":"GitHub"}'])(
    'rejects missing or malformed success evidence: %s', content => {
      if (content) fs.writeFileSync(path.join(resultDir, 'result.json'), content);
      expect(() => verifyResult(resultDir)).toThrow();
    },
  );

  it('refuses to launch without the AWF proxy', () => {
    delete process.env.HTTPS_PROXY;
    const originalLowercase = process.env.https_proxy;
    delete process.env.https_proxy;
    try {
      expect(() => runCheck(resultDir)).toThrow('AWF HTTPS_PROXY is required');
      expect(spawn).not.toHaveBeenCalled();
      expect(() => verifyResult(resultDir)).toThrow();
    } finally {
      if (originalLowercase !== undefined) process.env.https_proxy = originalLowercase;
    }
  });
});
