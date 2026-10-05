/**
 * Token-usage log discoverability after cleanup.
 *
 * The api-proxy writes token-usage.jsonl into a bind-mounted directory whose
 * runner-side location depends on --proxy-logs-dir, the work dir, and
 * --docker-host-path-prefix (ARC/DinD). preserveCleanupArtifacts must report
 * and export (AWF_TOKEN_USAGE_LOG via $GITHUB_ENV) the path where the file
 * actually is, so post-run consumers need not hardcode /tmp/gh-aw/... paths.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';
import {
  preserveCleanupArtifacts,
  TOKEN_USAGE_LOG_ENV_VAR,
} from './artifact-preservation';

const TOKEN_USAGE_LOG_FILENAME = 'token-usage.jsonl';

describe('preserveCleanupArtifacts – token usage log path', () => {
  const originalGithubEnv = process.env.GITHUB_ENV;
  let scratch: string;
  let workDir: string;
  let githubEnvFile: string;
  const extraCleanup: string[] = [];

  function writeTokenUsage(apiProxyLogsDir: string): string {
    fs.mkdirSync(apiProxyLogsDir, { recursive: true });
    const file = path.join(apiProxyLogsDir, TOKEN_USAGE_LOG_FILENAME);
    fs.writeFileSync(file, '{"_schema":"token-usage/v0.0.0-dev"}\n');
    return file;
  }

  function readExports(): string {
    return fs.existsSync(githubEnvFile) ? fs.readFileSync(githubEnvFile, 'utf8') : '';
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-token-usage-test-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
    githubEnvFile = path.join(scratch, 'github-env');
    fs.writeFileSync(githubEnvFile, '');
    process.env.GITHUB_ENV = githubEnvFile;
  });

  afterEach(() => {
    if (originalGithubEnv === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = originalGithubEnv;
    for (const dir of [scratch, workDir, ...extraCleanup.splice(0)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports the token-usage path under --proxy-logs-dir', () => {
    const proxyLogsDir = path.join(scratch, 'firewall', 'logs');
    const tokenUsage = writeTokenUsage(path.join(proxyLogsDir, 'api-proxy-logs'));

    preserveCleanupArtifacts(workDir, { proxyLogsDir });

    expect(readExports()).toBe(`${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsage}\n`);
  });

  it('exports the token-usage path from a configured API-proxy log subdirectory', () => {
    const proxyLogsDir = path.join(scratch, 'firewall', 'logs');
    const tokenLogDir = '/var/log/api-proxy/custom';
    const tokenUsage = writeTokenUsage(path.join(proxyLogsDir, 'api-proxy-logs', 'custom'));

    preserveCleanupArtifacts(workDir, { proxyLogsDir, tokenLogDir });

    expect(readExports()).toBe(`${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsage}\n`);
  });

  it('keeps the RUNNER_TEMP path under arc-dind with a daemon-only /host prefix', () => {
    // gh-aw arc-dind passes --proxy-logs-dir ${RUNNER_TEMP}/gh-aw/sandbox/firewall/logs;
    // the daemon writes it via /host<path>, which is the runner path itself.
    const runnerTemp = path.join(scratch, '_work', '_temp');
    const proxyLogsDir = path.join(runnerTemp, 'gh-aw', 'sandbox', 'firewall', 'logs');
    const tokenUsage = writeTokenUsage(path.join(proxyLogsDir, 'api-proxy-logs'));

    preserveCleanupArtifacts(workDir, { proxyLogsDir, dockerHostPathPrefix: '/host' });

    expect(readExports()).toBe(`${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsage}\n`);
  });

  it('follows the shared /tmp prefix translation for a log dir outside /tmp', () => {
    // A shared /tmp prefix rewrites the bind source to /tmp<dir>; that is where
    // the daemon writes the file and where the runner must read it.
    const outsideTmp = `/awf-token-usage-test-${path.basename(scratch)}`;
    const proxyLogsDir = path.join(outsideTmp, 'gh-aw', 'sandbox', 'firewall', 'logs');
    extraCleanup.push(path.join('/tmp', outsideTmp));
    const tokenUsage = writeTokenUsage(path.join('/tmp', proxyLogsDir, 'api-proxy-logs'));

    preserveCleanupArtifacts(workDir, { proxyLogsDir, dockerHostPathPrefix: '/tmp' });

    expect(readExports()).toBe(`${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsage}\n`);
    expect(fs.existsSync(proxyLogsDir)).toBe(false);
  });

  it('preserves and repairs startup diagnostics at the original host path after translation', () => {
    const proxyLogsDir = path.join('/var/tmp', `awf-startup-diagnostic-${path.basename(scratch)}`);
    const diagnosticPath = path.join(proxyLogsDir, 'awf-startup-error.json');
    extraCleanup.push(proxyLogsDir);
    fs.mkdirSync(proxyLogsDir, { recursive: true });
    fs.writeFileSync(diagnosticPath, '{"phase":"startup"}\n', { mode: 0o600 });

    preserveCleanupArtifacts(workDir, { proxyLogsDir, dockerHostPathPrefix: '/tmp' });

    expect(fs.statSync(diagnosticPath).mode & 0o777).toBe(0o644);
  });

  it('exports the preserved /tmp location when logs were written to the work dir', () => {
    writeTokenUsage(path.join(workDir, 'api-proxy-logs'));
    const timestamp = path.basename(workDir).replace('awf-', '');
    const preserved = path.join(os.tmpdir(), `api-proxy-logs-${timestamp}`);
    extraCleanup.push(preserved);

    preserveCleanupArtifacts(workDir);

    expect(readExports()).toBe(
      `${TOKEN_USAGE_LOG_ENV_VAR}=${path.join(preserved, TOKEN_USAGE_LOG_FILENAME)}\n`,
    );
  });

  it('exports nothing when the api-proxy wrote no token usage', () => {
    const proxyLogsDir = path.join(scratch, 'logs');
    fs.mkdirSync(path.join(proxyLogsDir, 'api-proxy-logs'), { recursive: true });

    preserveCleanupArtifacts(workDir, { proxyLogsDir });

    expect(readExports()).toBe('');
  });

  it('does not throw when $GITHUB_ENV is unset or unwritable', () => {
    const proxyLogsDir = path.join(scratch, 'logs');
    writeTokenUsage(path.join(proxyLogsDir, 'api-proxy-logs'));

    delete process.env.GITHUB_ENV;
    expect(() => preserveCleanupArtifacts(workDir, { proxyLogsDir })).not.toThrow();

    process.env.GITHUB_ENV = path.join(scratch, 'missing-dir', 'github-env');
    expect(() => preserveCleanupArtifacts(workDir, { proxyLogsDir })).not.toThrow();
  });

  it('refuses to export a path containing a newline', () => {
    const proxyLogsDir = path.join(scratch, 'evil\nINJECTED=1');
    writeTokenUsage(path.join(proxyLogsDir, 'api-proxy-logs'));

    preserveCleanupArtifacts(workDir, { proxyLogsDir });

    expect(readExports()).toBe('');
  });
});
