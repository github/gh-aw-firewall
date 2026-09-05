import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recoverHostPaths } from './host-path-recovery';

// Mock the logger to keep test output clean and allow assertions if needed.
jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * Regression tests for the `sudo -E awf` boundary described in
 * github/gh-aw-firewall#8141: sudoers `secure_path` can silently replace the
 * runner's $GITHUB_PATH-augmented PATH with a fixed value (typically
 * "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin") before AWF
 * ever sees process.env.PATH. These tests simulate that exact boundary by
 * setting process.env.PATH to a "secure_path"-style value while pointing
 * $GITHUB_PATH / $GITHUB_ENV at real files containing entries a setup-*
 * action (e.g. ruby/setup-ruby) would have written *before* sudo stripped
 * them from PATH.
 */
describe('recoverHostPaths (sudo secure_path boundary)', () => {
  const originalEnv = process.env;
  const originalGetuid = process.getuid;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-path-recovery-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalGetuid) {
      Object.defineProperty(process, 'getuid', { value: originalGetuid, configurable: true });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

  it('prepends the hosted-toolcache Ruby bin dir ahead of /usr/bin even when secure_path stripped it from PATH', () => {
    const rubyBin = '/opt/hostedtoolcache/Ruby/3.4.8/x64/bin';

    // Simulate ruby/setup-ruby having called core.addPath() *before* sudo ran:
    // the $GITHUB_PATH file retains the entry regardless of what sudo does to PATH.
    const githubPathFile = path.join(tmpDir, 'github_path');
    fs.writeFileSync(githubPathFile, `${rubyBin}\n`);
    process.env.GITHUB_PATH = githubPathFile;

    // Simulate the sudo secure_path boundary: process.env.PATH as observed by
    // AWF (running as root under `sudo -E`) is the sudoers-fixed value, with
    // no trace of the runner's setup-ruby PATH prepend.
    process.env.PATH = SECURE_PATH;

    const environment: Record<string, string> = {};
    recoverHostPaths(environment);

    expect(environment.AWF_HOST_PATH).toBeDefined();
    const entries = environment.AWF_HOST_PATH.split(':');
    const rubyIdx = entries.indexOf(rubyBin);
    const usrBinIdx = entries.indexOf('/usr/bin');

    expect(rubyIdx).toBeGreaterThanOrEqual(0);
    expect(usrBinIdx).toBeGreaterThanOrEqual(0);
    expect(rubyIdx).toBeLessThan(usrBinIdx);
  });

  it('recovers toolchain env vars (e.g. GOROOT) from $GITHUB_ENV when sudo stripped them from process.env', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_USER = 'runner';
    delete process.env.SUDO_UID;
    delete process.env.GOROOT;

    const githubEnvFile = path.join(tmpDir, 'github_env');
    fs.writeFileSync(githubEnvFile, 'GOROOT=/opt/hostedtoolcache/go/1.22.0/x64\n');
    process.env.GITHUB_ENV = githubEnvFile;
    process.env.PATH = SECURE_PATH;

    const environment: Record<string, string> = {};
    recoverHostPaths(environment);

    expect(environment.AWF_GOROOT).toBe('/opt/hostedtoolcache/go/1.22.0/x64');
  });

  it('does not attempt $GITHUB_ENV recovery when not running under sudo (no SUDO_UID/SUDO_USER)', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    delete process.env.SUDO_UID;
    delete process.env.SUDO_USER;
    delete process.env.GOROOT;

    const githubEnvFile = path.join(tmpDir, 'github_env');
    fs.writeFileSync(githubEnvFile, 'GOROOT=/opt/hostedtoolcache/go/1.22.0/x64\n');
    process.env.GITHUB_ENV = githubEnvFile;
    process.env.PATH = SECURE_PATH;

    const environment: Record<string, string> = {};
    recoverHostPaths(environment);

    expect(environment.AWF_GOROOT).toBeUndefined();
  });

  it('falls back to the (already stripped) PATH unmodified when $GITHUB_PATH is not set', () => {
    delete process.env.GITHUB_PATH;
    process.env.PATH = SECURE_PATH;

    const environment: Record<string, string> = {};
    recoverHostPaths(environment);

    expect(environment.AWF_HOST_PATH).toBe(SECURE_PATH);
  });
});
