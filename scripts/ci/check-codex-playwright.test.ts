import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'node:child_process';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

const { runCheck } = require('../../.github/workflows/shared/check-codex-playwright.cjs');

function closeResult(args: string[], status = 'closed') {
  return JSON.stringify({ session: args[0].slice('-s='.length), status });
}

describe('Codex Playwright title check', () => {
  const spawn = childProcess.spawnSync as jest.Mock;
  let originalProxy: string | undefined;

  beforeEach(() => {
    originalProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://172.30.0.10:3128';
    spawn.mockReset();
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, signal: null, pid: 1, output: [],
      stdout: args.includes('eval') ? '"GitHub · Build and ship software"' : args.includes('close') ? closeResult(args) : '',
      stderr: '',
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    jest.restoreAllMocks();
  });

  it('uses provisioned Chromium, explicit smoke-only sandbox options, and the AWF proxy', () => {
    let configFile!: string;
    let config: { browser: unknown };
    spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.includes('open')) {
        configFile = args.find(arg => arg.startsWith('--config='))!.slice('--config='.length);
        config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      }
      expect(console.log).not.toHaveBeenCalled();
      return { status: 0, stdout: args.includes('eval') ? '"GitHub"' : args.includes('close') ? closeResult(args) : '', stderr: '' };
    });
    runCheck();
    expect(config!.browser).toEqual({
      browserName: 'chromium', isolated: true,
      launchOptions: {
        headless: true, chromiumSandbox: false,
        proxy: { server: 'http://172.30.0.10:3128', bypass: 'localhost,127.0.0.1' },
      },
    });
    expect(spawn.mock.calls[0][1]).toEqual([
      expect.stringMatching(/^-s=codex-smoke-/), 'open', '--browser=chromium',
      `--config=${configFile}`, 'https://github.com',
    ]);
    expect(spawn.mock.calls[1][1]).toContain('() => document.title');
    expect(spawn.mock.calls[2][1]).toEqual([spawn.mock.calls[0][1][0], '--json', 'close']);
    expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 90000 });
    expect(console.log).toHaveBeenCalledWith('Playwright GitHub title check: PASS');
    expect(fs.existsSync(path.dirname(configFile))).toBe(false);
  });

  it.each([
    ['SUID launch failure', 1, 'The SUID sandbox helper binary was found'],
    ['zero-exit launch error', 0, 'Missing Chromium'],
  ])('fails closed on %s even when close also fails', (_name, status, stderr) => {
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: args.includes('open') ? status : 1,
      stdout: status === 0 && args.includes('open') ? '### Error\nLaunch failed' : '',
      stderr, signal: null,
    }));
    expect(runCheck).toThrow(new RegExp(`playwright-cli open failed.*${stderr}`));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cleanup also failed: playwright-cli close failed'));
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong title', '"Example Domain"'],
    ['zero-exit tool error', '### Error\nGitHub navigation failed'],
    ['non-string result', '{"title":"GitHub"}'],
  ])('does not accept %s as a title result', (_name, stdout) => {
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, stdout: args.includes('eval') ? stdout : args.includes('close') ? closeResult(args) : '', stderr: '', signal: null,
    }));
    expect(runCheck).toThrow('Playwright title check failed');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('identifies eval and includes bounded, escaped spawn and output diagnostics', () => {
    spawn.mockImplementation((_command: string, args: string[]) => args.includes('eval') ? {
      status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT'),
      stderr: `\n::error::proxy denied%${'x'.repeat(5000)}`, stdout: 'Captured stdout',
    } : { status: 0, stdout: args.includes('close') ? closeResult(args) : '', stderr: '' });
    let error: Error | undefined;
    try {
      runCheck();
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain('playwright-cli eval failed (exit=null, signal=SIGTERM)');
    expect(error?.message).toContain('ETIMEDOUT');
    expect(error?.message).toContain('Captured stdout');
    expect(error?.message).toContain('\\n\\u003a\\u003aerror');
    expect(error?.message).not.toMatch(/[\r\n%]|::error::/);
    expect(error!.message.length).toBeLessThan(900);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('fails when close returns a tool error after a valid title', () => {
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, stdout: args.includes('eval') ? '"GitHub"' : args.includes('close') ? '### Error\nNot closed' : '',
      stderr: '',
    }));
    expect(runCheck).toThrow(/playwright-cli close failed.*Not closed/);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('fails when an already closed session is reported as a successful command', () => {
    spawn.mockImplementation((_command: string, args: string[]) => ({
      status: 0, stdout: args.includes('eval') ? '"GitHub"' : args.includes('close') ? closeResult(args, 'not-open') : '',
      stderr: '',
    }));
    expect(runCheck).toThrow(/playwright-cli close did not confirm session closure.*not-open/);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('refuses to launch without the AWF proxy', () => {
    delete process.env.HTTPS_PROXY;
    const originalLowercase = process.env.https_proxy;
    delete process.env.https_proxy;
    try {
      expect(runCheck).toThrow('AWF HTTPS_PROXY is required');
      expect(spawn).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      if (originalLowercase !== undefined) process.env.https_proxy = originalLowercase;
    }
  });
});
