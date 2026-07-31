import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';

/**
 * End-to-end exercise of the whole agent-visible path:
 *
 *   real `bounded-query` wrapper → real Unix socket → real broker server →
 *   real workspace/seed handling → (mocked) query container.
 *
 * Only the Docker launch is mocked, so this covers the v2 framing (repo +
 * base64url schema header), the finite schema DSL, the writable-copy
 * semantics, repository isolation, the per-repository sensitivity/bit
 * ledger (no per-query cap), the operational invocation budget, and the
 * uniform failure closure — without needing a Docker daemon or a real
 * private repository.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const { createServer, listenOnSocket } = require(path.join(brokerDir, 'server.js'));
const workspace = require(path.join(brokerDir, 'workspace.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const WRAPPER = path.join(__dirname, '..', '..', 'containers', 'agent', 'bounded-query-wrapper.sh');
const CANONICAL_ERROR = '{"status":"error"}';
const OUTCOME_SCHEMA = JSON.stringify({ type: 'enum', values: ['YES', 'NO'] });

interface WrapperResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runWrapper(socketPath: string, args: string[], script = 'query'): Promise<WrapperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [WRAPPER, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AWF_BOUNDED_QUERY_SOCKET: socketPath },
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

describe('bounded query end-to-end (wrapper → socket → broker)', () => {
  let root: string;
  let server: Server;
  let socketPath: string;
  let config: Record<string, unknown>;
  const seedIdA = 'a'.repeat(32);
  const seedIdB = 'b'.repeat(32);
  const audit: Array<Record<string, unknown>> = [];

  /** The mocked query: reads the repo copy and writes a declared outcome. */
  const runner = {
    runQueryContainer: async ({ invocationId }: { invocationId: string }) => {
      const invocationDir = path.join(String(config.workDir), invocationId);
      const readme = fs.readFileSync(path.join(invocationDir, 'repo', 'README.md'), 'utf8');
      // Write the answer to the pre-created output file, conforming to the enum schema above.
      fs.writeFileSync(path.join(invocationDir, 'out'), JSON.stringify(readme.includes('alpha') ? 'YES' : 'NO'));
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
      queryMountDir: '/query',
      queryScriptPath: '/awf/query-script.py',
      querySeccompPath: '/opt/awf/query-seccomp.json',
      queryImage: 'bounded-query:test',
      queryBackend: 'docker',
      memoryLimit: '512m',
      timeoutSeconds: 30,
      maxInvocations: 2,
      queryUid: process.getuid?.() ?? 0,
      queryGid: process.getgid?.() ?? 0,
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
      seedMap: new Map([
        ['octo/alpha', { seedId: seedIdA, sensitivity: 'internal' }],
        ['octo/beta', { seedId: seedIdB, sensitivity: 'confidential' }],
      ]),
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

  const args = (repo: string, schema = OUTCOME_SCHEMA) => ['--repo', repo, '--schema', schema];

  it('returns the outcome the query computed from its own repository copy', async () => {
    const result = await runWrapper(socketPath, args('octo/alpha'));

    expect(result.stdout).toBe('{"status":"ok","result":"YES"}\n');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('gives each repository its own contents and never the other one', async () => {
    expect((await runWrapper(socketPath, args('octo/beta'))).stdout).toBe('{"status":"ok","result":"NO"}\n');
  });

  it('leaves the immutable seed untouched after the query mutates its copy', async () => {
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

  it('enforces the operational invocation budget across the socket, independent of the bit budget', async () => {
    const first = await runWrapper(socketPath, args('octo/alpha'));
    const second = await runWrapper(socketPath, args('octo/alpha'));
    const third = await runWrapper(socketPath, args('octo/alpha'));

    expect(first.stdout).toBe('{"status":"ok","result":"YES"}\n');
    expect(second.stdout).toBe('{"status":"ok","result":"YES"}\n');
    expect(third.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(third.stderr).toBe('');
    expect(third.status).toBe(0);
  });

  it('enforces the confidential (8-bit) per-repository run budget across the socket', async () => {
    // octo/beta is "confidential" (8 bits/run). A 2-value enum costs
    // 1 + 1 + 3 = 5 bits, so two invocations (10 bits) exceed the budget —
    // the second must be denied even though maxInvocations (2) alone would
    // still allow it.
    const first = await runWrapper(socketPath, args('octo/beta'));
    const second = await runWrapper(socketPath, args('octo/beta'));

    expect(first.stdout).toBe('{"status":"ok","result":"NO"}\n');
    expect(second.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(audit.some((record) => record.reason === 'bit-budget-exhausted')).toBe(true);
  });

  it('rejects an oversized script and charges it against maxInvocations', async () => {
    const result = await runWrapper(socketPath, args('octo/alpha'), 'x'.repeat(64 * 1024 + 10));
    const admitted = await runWrapper(socketPath, args('octo/alpha'));
    const exhausted = await runWrapper(socketPath, args('octo/alpha'));

    expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(admitted.stdout).toBe('{"status":"ok","result":"YES"}\n');
    expect(exhausted.stdout).toBe(`${CANONICAL_ERROR}\n`);
  });

  it('rejects a request whose query output does not conform to its own declared schema', async () => {
    const nonConformingRunner = {
      runQueryContainer: async ({ invocationId }: { invocationId: string }) => {
        const invocationDir = path.join(String(config.workDir), invocationId);
        fs.writeFileSync(path.join(invocationDir, 'out'), '"MAYBE"'); // not in the declared enum
        return { exitCode: 0, timedOut: false };
      },
    };
    const auditLog = {
      invocation: () => { /* not asserted */ },
      failure: (invocationId: string, reason: string) => audit.push({ kind: 'failure', invocationId, reason }),
      lifecycle: () => { /* not asserted */ },
    };
    const broker = createBroker({
      config,
      seedMap: new Map([['octo/alpha', { seedId: seedIdA, sensitivity: 'internal' }]]),
      runId: 'e2e-run-2',
      audit: auditLog,
      workspace,
      runner: nonConformingRunner,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ broker, audit: auditLog });
    await listenOnSocket(server, config, auditLog);

    const result = await runWrapper(socketPath, args('octo/alpha'));

    expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(result.status).toBe(0);
  });
});
