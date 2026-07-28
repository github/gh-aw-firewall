import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';

/**
 * End-to-end exercise of the whole agent-visible path:
 *
 *   real `sealed-probe` wrapper → real Unix socket → real broker server →
 *   real workspace/seed handling → (mocked) probe container.
 *
 * Only the Docker launch is mocked, so this covers the framing, the protocol,
 * the writable-copy semantics, repository isolation, the invocation budget,
 * and the uniform failure closure without needing a Docker daemon or a real
 * private repository.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const { createServer, listenOnSocket } = require(path.join(brokerDir, 'server.js'));
const workspace = require(path.join(brokerDir, 'workspace.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const WRAPPER = path.join(__dirname, '..', '..', 'containers', 'agent', 'sealed-probe-wrapper.sh');
const CANONICAL_ERROR = '{"result":"ERROR"}';

interface WrapperResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runWrapper(socketPath: string, args: string[], script = 'probe'): Promise<WrapperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [WRAPPER, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AWF_SEALED_PROBE_SOCKET: socketPath },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
    child.stdin.on('error', () => { /* wrapper may exit before reading stdin */ });
    child.stdin.end(script);
  });
}

describe('sealed probe end-to-end (wrapper → socket → broker)', () => {
  let root: string;
  let server: Server;
  let socketPath: string;
  let config: Record<string, unknown>;
  const seedIdA = 'a'.repeat(32);
  const seedIdB = 'b'.repeat(32);
  const audit: Array<Record<string, unknown>> = [];

  /** The mocked probe: reads the repo copy and writes a declared outcome. */
  const runner = {
    runProbeContainer: async ({ invocationId }: { invocationId: string }) => {
      const probeDir = path.join(String(config.workDir), invocationId, 'probe');
      const readme = fs.readFileSync(path.join(probeDir, 'repo', 'README.md'), 'utf8');
      fs.writeFileSync(path.join(probeDir, 'repo', 'README.md'), 'probe mutated this\n');
      fs.writeFileSync(
        path.join(probeDir, 'out'),
        JSON.stringify({ result: readme.includes('alpha') ? 'YES' : 'NO' }),
      );
      return { exitCode: 0, timedOut: false };
    },
  };

  function lockdown(target: string): void {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) lockdown(path.join(target, entry));
    }
    fs.chmodSync(target, stat.mode & ~0o222);
  }

  function unlock(target: string): void {
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    fs.chmodSync(target, stat.mode | 0o700);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) unlock(path.join(target, entry));
    }
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awfe2e-'));
    socketPath = path.join(root, 'b.sock');
    config = {
      seedsDir: path.join(root, 'seeds'),
      workDir: path.join(root, 'work'),
      hostWorkDir: '/daemon/work',
      socketDir: root,
      socketPath,
      probeMountDir: '/probe',
      probeScriptPath: '/awf/probe-script.py',
      probeSeccompPath: '/opt/awf/probe-seccomp.json',
      probeImage: 'sealed-probe:test',
      dockerRuntime: '',
      memoryLimit: '512m',
      timeoutSeconds: 30,
      maxInvocations: 2,
      probeUid: process.getuid?.() ?? 0,
      probeGid: process.getgid?.() ?? 0,
      socketUid: process.getuid?.() ?? 0,
      socketGid: process.getgid?.() ?? 0,
    };

    fs.mkdirSync(String(config.workDir), { recursive: true });
    for (const [seedId, marker] of [[seedIdA, 'alpha'], [seedIdB, 'beta']]) {
      const dir = path.join(String(config.seedsDir), seedId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), `${marker} private contents\n`);
      lockdown(dir);
    }

    audit.length = 0;
    const auditLog = {
      invocation: (record: Record<string, unknown>) => audit.push({ kind: 'invocation', ...record }),
      failure: (invocationId: string, reason: string) => audit.push({ kind: 'failure', invocationId, reason }),
      lifecycle: () => { /* not asserted */ },
    };

    const broker = createBroker({
      config,
      seedMap: new Map([['octo/alpha', seedIdA], ['octo/beta', seedIdB]]),
      runId: 'e2e-run',
      audit: auditLog,
      workspace,
      runner,
    });

    server = createServer({ broker, audit: auditLog });
    await listenOnSocket(server, config, auditLog);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlock(String(config.seedsDir));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const args = (repo: string) => ['--repo', repo, '--outcome', 'YES', '--outcome', 'NO', '--outcome', 'UNKNOWN'];

  it('returns the outcome the probe computed from its own repository copy', async () => {
    const result = await runWrapper(socketPath, args('octo/alpha'));

    expect(result.stdout).toBe('{"result":"YES"}\n');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('gives each repository its own contents and never the other one', async () => {
    expect((await runWrapper(socketPath, args('octo/beta'))).stdout).toBe('{"result":"NO"}\n');
  });

  it('leaves the immutable seed untouched after the probe mutates its copy', async () => {
    await runWrapper(socketPath, args('octo/alpha'));

    expect(fs.readFileSync(path.join(String(config.seedsDir), seedIdA, 'README.md'), 'utf8'))
      .toBe('alpha private contents\n');
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('rejects a repository the client asks for but AWF never configured', async () => {
    const result = await runWrapper(socketPath, args('octo/not-configured'));

    expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(audit.some((record) => record.reason === 'repo-not-allowed')).toBe(true);
  });

  it('enforces the invocation budget across the socket', async () => {
    const first = await runWrapper(socketPath, args('octo/alpha'));
    const second = await runWrapper(socketPath, args('octo/alpha'));
    const third = await runWrapper(socketPath, args('octo/alpha'));

    expect(first.stdout).toBe('{"result":"YES"}\n');
    expect(second.stdout).toBe('{"result":"YES"}\n');
    expect(third.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(third.stderr).toBe('');
    expect(third.status).toBe(0);
  });

  it('rejects an oversized script with the canonical error', async () => {
    const result = await runWrapper(socketPath, args('octo/alpha'), 'x'.repeat(64 * 1024 + 10));

    expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
