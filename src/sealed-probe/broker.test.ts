import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Behavioural tests for the trusted broker, exercised through its real
 * filesystem workspace code with a mocked Docker runner.
 *
 * These stand in for a full end-to-end probe run: they prove the writable-copy
 * semantics, the seed's immutability, repository isolation, the invocation
 * budget, workspace teardown, and — most importantly — that every failure path
 * produces the byte-identical canonical `ERROR` with no extra signal.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const workspace = require(path.join(brokerDir, 'workspace.js'));
const { buildProbeArgs } = require(path.join(brokerDir, 'probe-runner.js'));
const { buildRequestFromFrame } = require(path.join(brokerDir, 'framing.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const CANONICAL_ERROR = '{"result":"ERROR"}';
const OUTCOMES = ['YES', 'NO', 'UNKNOWN'];

interface AuditRecord {
  kind: string;
  reason?: string;
  [key: string]: unknown;
}

function createAudit(): { records: AuditRecord[]; log: Record<string, (...args: never[]) => void> } {
  const records: AuditRecord[] = [];
  return {
    records,
    log: {
      invocation: (record: never) => records.push({ kind: 'invocation', ...(record as object) }),
      failure: ((invocationId: string, reason: string, detail?: string) =>
        records.push({ kind: 'failure', invocationId, reason, detail })) as never,
      lifecycle: ((event: string) => records.push({ kind: 'lifecycle', event })) as never,
    } as unknown as Record<string, (...args: never[]) => void>,
  };
}

describe('sealed-probe broker', () => {
  let root: string;
  let config: Record<string, unknown>;
  let seedMap: Map<string, string>;
  const seedIdA = 'a'.repeat(32);
  const seedIdB = 'b'.repeat(32);

  function seedPath(seedId: string): string {
    return path.join(String(config.seedsDir), seedId);
  }

  /** Creates an immutable seed with the same read-only guarantee as staging. */
  function createSeed(seedId: string, files: Record<string, string>): void {
    const target = seedPath(seedId);
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(target, name), contents);
    }
    const lockdown = (p: string): void => {
      const stat = fs.lstatSync(p);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(p)) lockdown(path.join(p, entry));
      }
      fs.chmodSync(p, stat.mode & ~0o222);
    };
    lockdown(target);
  }

  function unlockSeeds(): void {
    const unlock = (p: string): void => {
      if (!fs.existsSync(p)) return;
      const stat = fs.lstatSync(p);
      fs.chmodSync(p, stat.mode | 0o700);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(p)) unlock(path.join(p, entry));
      }
    };
    unlock(String(config.seedsDir));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-broker-test-'));
    config = {
      seedsDir: path.join(root, 'seeds'),
      workDir: path.join(root, 'work'),
      hostWorkDir: '/daemon/work',
      probeMountDir: '/probe',
      probeScriptPath: '/awf/probe-script.py',
      probeSeccompPath: '/opt/awf/probe-seccomp.json',
      probeImage: 'ghcr.io/example/sealed-probe:1',
      dockerRuntime: '',
      memoryLimit: '512m',
      timeoutSeconds: 30,
      maxInvocations: 3,
      // The real broker runs as root; tests keep the invoking uid so the
      // ownership transfer is exercised without requiring privileges.
      probeUid: process.getuid?.() ?? 0,
      probeGid: process.getgid?.() ?? 0,
    };
    fs.mkdirSync(String(config.workDir), { recursive: true });
    fs.mkdirSync(String(config.seedsDir), { recursive: true });
    createSeed(seedIdA, { 'README.md': 'repo A secret\n' });
    createSeed(seedIdB, { 'README.md': 'repo B secret\n' });
    seedMap = new Map([
      ['octo/alpha', seedIdA],
      ['octo/beta', seedIdB],
    ]);
  });

  afterEach(() => {
    unlockSeeds();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build(
    runner: { runProbeContainer: (params: never) => Promise<unknown> },
    workspaceOverride = workspace,
  ) {
    const audit = createAudit();
    const broker = createBroker({
      config,
      seedMap,
      runId: 'run-1234abcd',
      audit: audit.log,
      workspace: workspaceOverride,
      runner,
    });
    return { broker, audit };
  }

  /** Mock runner that behaves like a probe script executing inside the sandbox. */
  function probeRunner(behaviour: (invocationDir: string) => void, overrides: Record<string, unknown> = {}) {
    const seen: string[] = [];
    return {
      seen,
      runProbeContainer: async ({ invocationId }: { invocationId: string }) => {
        // The invocation root contains the assigned seed copy, output file, and
        // submitted script. The fixed entrypoint copies the read-only seed
        // mount into bounded tmpfs before running the script.
        const invocationDir = path.join(String(config.workDir), invocationId);
        seen.push(invocationDir);
        behaviour(invocationDir);
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '', ...overrides };
      },
    } as unknown as { runProbeContainer: (params: never) => Promise<unknown> } & { seen: string[] };
  }

  const validRequest = (repo = 'octo/alpha') => ({
    privateRepo: repo,
    outcomes: [...OUTCOMES],
    script: 'probe',
  });

  it('returns the canonically re-serialized declared outcome', async () => {
    const runner = probeRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '  {"result": "YES"}  ');
    });
    const { broker } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe('{"result":"YES"}');
  });

  it('gives the probe a read-only copy of the repo and leaves the seed unchanged', async () => {
    let observed = '';
    const runner = probeRunner((invocationDir) => {
      // Probe reads from the repo copy (mounted :ro in Docker).
      observed = fs.readFileSync(path.join(invocationDir, 'repo', 'README.md'), 'utf8');
      // Probe writes its answer to the pre-created out file.
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"NO"}');
    });
    const { broker } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe('{"result":"NO"}');
    expect(observed).toBe('repo A secret\n');
    // The seed itself is untouched.
    expect(fs.readFileSync(path.join(seedPath(seedIdA), 'README.md'), 'utf8')).toBe('repo A secret\n');
    expect(fs.existsSync(path.join(seedPath(seedIdA), 'src'))).toBe(true);
  });

  it('destroys the per-invocation copy afterwards', async () => {
    const runner = probeRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    });
    const { broker } = build(runner);

    await broker.handle(validRequest());

    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('never exposes another repository or the seed parent to a probe', async () => {
    let repoContents = '';
    let siblings: string[] = [];
    const runner = probeRunner((invocationDir) => {
      repoContents = fs.readFileSync(path.join(invocationDir, 'repo', 'README.md'), 'utf8');
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      // In Docker the probe sees /probe/ containing only repo/ and out (tmpfs).
      // On the host the invocation root also holds script.py (mounted at
      // probeScriptPath, outside /probe in Docker). Verify no private data leaks.
      siblings = fs.readdirSync(invocationDir).sort();
    });
    const { broker } = build(runner);

    await broker.handle(validRequest('octo/beta'));

    expect(repoContents).toBe('repo B secret\n');
    // script.py is the submitted (non-secret) script; out and repo are expected.
    expect(siblings).toEqual(['out', 'repo', 'script.py']);
    // No trace of the other seed.
    expect(repoContents).not.toContain('repo A');
  });

  it('rejects a repository outside the AWF-generated map without launching', async () => {
    const runner = probeRunner(() => {
      throw new Error('probe must not launch');
    });
    const { broker, audit } = build(runner);

    await expect(broker.handle(validRequest('octo/not-configured'))).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ kind: 'failure', reason: 'repo-not-allowed' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it.each([
    ['extra launch control', { ...{ privateRepo: 'octo/alpha', outcomes: [...OUTCOMES], script: 'x' }, image: 'evil' }],
    ['caller-supplied schema', { privateRepo: 'octo/alpha', outcomes: [...OUTCOMES], script: 'x', schema: {} }],
    ['four outcomes', { privateRepo: 'octo/alpha', outcomes: ['A', 'B', 'C', 'D'], script: 'x' }],
    ['reserved outcome', { privateRepo: 'octo/alpha', outcomes: ['A', 'B', 'ERROR'], script: 'x' }],
    ['path selector', { privateRepo: '../../seeds', outcomes: [...OUTCOMES], script: 'x' }],
  ])('rejects %s before copying or launching', async (_name, request) => {
    const runner = probeRunner(() => {
      throw new Error('probe must not launch');
    });
    const { broker, audit } = build(runner);

    await expect(broker.handle(request)).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'invalid-request' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it.each([
    [
      'no output file',
      (invocationDir: string): void => {
        // Remove the pre-created output file to simulate a probe that never wrote.
        fs.unlinkSync(path.join(invocationDir, 'out'));
      },
      'unreadable-output',
    ],
    [
      'oversized output',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), 'x'.repeat(4096));
      },
      'unreadable-output',
    ],
    [
      'symlinked output',
      (invocationDir: string): void => {
        // Replace the pre-created output file with a symlink to test that
        // readProbeOutput rejects symlinks (O_NOFOLLOW defence).
        fs.unlinkSync(path.join(invocationDir, 'out'));
        fs.symlinkSync('/etc/hosts', path.join(invocationDir, 'out'));
      },
      'unreadable-output',
    ],
    [
      'undeclared outcome',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"MAYBE"}');
      },
      'nonconformant-output',
    ],
    [
      'extra fields',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES","leak":"secret"}');
      },
      'nonconformant-output',
    ],
    [
      'duplicate keys',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES","result":"NO"}');
      },
      'nonconformant-output',
    ],
    [
      'trailing bytes',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"} leaked');
      },
      'nonconformant-output',
    ],
    [
      'invalid UTF-8',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      },
      'unreadable-output',
    ],
    [
      'script-written ERROR',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"ERROR"}');
      },
      'nonconformant-output',
    ],
  ])('maps %s to the canonical error', async (_name, behaviour, reason) => {
    const runner = probeRunner(behaviour as (invocationDir: string) => void);
    const { broker, audit } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('maps a timeout to the canonical error', async () => {
    const runner = probeRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    }, { timedOut: true, exitCode: 137 });
    const { broker, audit } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'timeout' });
  });

  it('maps a non-zero probe exit to the canonical error even when output is valid', async () => {
    const runner = probeRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    }, { exitCode: 2 });
    const { broker, audit } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'non-zero-exit' });
  });

  it('maps cleanup failure to the canonical error instead of returning a valid outcome', async () => {
    const runner = probeRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    });
    const cleanupFailingWorkspace = {
      ...workspace,
      destroyInvocationWorkspace: () => {
        throw new Error('cleanup failed');
      },
    };
    const { broker, audit } = build(runner, cleanupFailingWorkspace);

    await expect(broker.handle(validRequest())).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'cleanup-failed' });
  });

  it('maps a launch failure to the canonical error', async () => {
    const runner = {
      runProbeContainer: async () => {
        throw new Error('daemon unreachable');
      },
    } as unknown as { runProbeContainer: (params: never) => Promise<unknown> };
    const { broker, audit } = build(runner);

    await expect(broker.handle(validRequest())).resolves.toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'launch-failed' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('produces byte-identical responses for success-shaped and every failure-shaped answer', async () => {
    const failures = await Promise.all([
      build(probeRunner(() => {})).broker.handle(validRequest()),
      build(probeRunner(() => {})).broker.handle(validRequest('octo/nope')),
      build(probeRunner(() => {})).broker.handle({ privateRepo: 'octo/alpha', outcomes: ['A'], script: 'x' }),
    ]);

    expect(new Set(failures)).toEqual(new Set([CANONICAL_ERROR]));
    for (const failure of failures) {
      expect(failure).toBe(CANONICAL_ERROR);
    }
  });

  it('enforces the per-run invocation budget atomically and without launching', async () => {
    const launches: string[] = [];
    const runner = {
      runProbeContainer: async ({ invocationId }: { invocationId: string }) => {
        launches.push(invocationId);
        const invocationDir = path.join(String(config.workDir), invocationId);
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
        return { exitCode: 0, timedOut: false };
      },
    } as unknown as { runProbeContainer: (params: never) => Promise<unknown> };
    const { broker, audit } = build(runner);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => broker.handle(validRequest())),
    );

    expect(results.filter((r) => r === '{"result":"YES"}')).toHaveLength(3);
    expect(results.filter((r) => r === CANONICAL_ERROR)).toHaveLength(2);
    expect(launches).toHaveLength(3);
    expect(audit.records.filter((r) => r.reason === 'budget-exhausted')).toHaveLength(2);
  });

  it('records failure reasons only in the protected audit log, never in the response', async () => {
    // Probe deletes the output file so the broker cannot read it.
    const runner = probeRunner((invocationDir) => {
      fs.unlinkSync(path.join(invocationDir, 'out'));
    });
    const { broker, audit } = build(runner);

    const response = await broker.handle(validRequest());

    expect(response).toBe(CANONICAL_ERROR);
    expect(JSON.stringify(audit.records)).toContain('unreadable-output');
  });

  it('preserves relative repository symlinks verbatim in the writable copy', () => {
    const seed = seedPath(seedIdA);
    fs.chmodSync(seed, 0o700);
    fs.symlinkSync('README.md', path.join(seed, 'README-link'));
    fs.chmodSync(seed, 0o500);

    const layout = workspace.createInvocationWorkspace({
      config,
      invocationId: 'symlink-test',
      seedId: seedIdA,
      script: 'pass',
    });

    expect(fs.readlinkSync(path.join(layout.repoDir, 'README-link'))).toBe('README.md');
  });
});

describe('probe container arguments', () => {
  const config = {
    hostWorkDir: '/daemon/work',
    probeMountDir: '/probe',
    probeScriptPath: '/awf/probe-script.py',
    probeSeccompPath: '/opt/awf/probe-seccomp.json',
    probeImage: 'ghcr.io/example/sealed-probe:1',
    dockerRuntime: '',
    memoryLimit: '256m',
    probeUid: 65534,
    probeGid: 65534,
  };

  function args(overrides: Record<string, unknown> = {}): string[] {
    return buildProbeArgs({
      config: { ...config, ...overrides },
      runId: 'run-1',
      invocationId: 'inv-1',
      containerName: 'awf-probe-inv-1',
    });
  }

  it('isolates the probe: no network, read-only rootfs, non-root, no capabilities', () => {
    const joined = args().join(' ');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--user 65534:65534');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges:true');
    expect(joined).toContain('--security-opt seccomp=/opt/awf/probe-seccomp.json');
  });

  it('bounds memory, CPU, PIDs, file size, and descriptors', () => {
    const joined = args().join(' ');
    expect(joined).toContain('--memory 256m');
    expect(joined).toContain('--memory-swap 256m');
    expect(joined).toContain('--cpus 1');
    expect(joined).toContain('--pids-limit 128');
    expect(joined).toContain('--ulimit fsize=');
    expect(joined).toContain('--ulimit nofile=1024:1024');
  });

  it('mounts only the invocation workspace and the fixed read-only script path', () => {
    const mounts = args().reduce<string[]>((acc, value, index, all) => {
      if (value === '-v') acc.push(all[index + 1]);
      return acc;
    }, []);

    expect(mounts).toEqual([
      '/daemon/work/inv-1/repo:/awf/seed:ro',
      '/daemon/work/inv-1/out:/probe/out:rw',
      '/daemon/work/inv-1/script.py:/awf/probe-script.py:ro',
    ]);
  });

  it('backs /probe with a size-limited tmpfs for aggregate storage enforcement', () => {
    const joined = args().join(' ');
    expect(joined).toMatch(/--tmpfs \/probe:rw,nosuid,nodev,size=\d+,uid=65534,gid=65534,mode=0700/);
    // No writable bind mount for the full /probe dir: a probe cannot fill the host FS
    expect(joined).not.toContain(':/probe:rw');
    expect(joined).not.toContain(':/probe/repo:rw');
  });

  it('never mounts the Docker socket, the seeds root, or a workspace', () => {
    const joined = args().join(' ');
    expect(joined).toContain('--pull never');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('/srv/awf/seeds');
    expect(joined).not.toContain('/host');
  });

  it('runs the fixed entrypoint that materializes the writable repo before the script', () => {
    const argv = args();
    expect(argv).toContain('--entrypoint');
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/usr/local/bin/run-probe');
    expect(argv[argv.length - 1]).toBe('ghcr.io/example/sealed-probe:1');
    expect(argv).not.toContain('-I');
  });

  it('labels the container for orphan cleanup', () => {
    expect(args().join(' ')).toContain('--label awf.sealed-probe.run=run-1');
  });

  it('passes an explicit OCI runtime only when one is configured', () => {
    expect(args().includes('--runtime')).toBe(false);
    expect(args({ dockerRuntime: 'runsc' }).join(' ')).toContain('--runtime runsc');
  });
});

describe('request framing', () => {
  const headers = {
    'x-awf-probe-version': '1',
    'x-awf-repo': 'octo/alpha',
    'x-awf-outcome-1': 'YES',
    'x-awf-outcome-2': 'NO',
    'x-awf-outcome-3': 'UNKNOWN',
  };
  const rawHeaders = Object.entries(headers).flat();

  it('assembles the canonical request object', () => {
    expect(buildRequestFromFrame(headers, rawHeaders, 'print(1)')).toEqual({
      request: { privateRepo: 'octo/alpha', outcomes: ['YES', 'NO', 'UNKNOWN'], script: 'print(1)' },
    });
  });

  it('rejects an unsupported protocol version', () => {
    expect(buildRequestFromFrame({ ...headers, 'x-awf-probe-version': '2' }, rawHeaders, 'x').error)
      .toMatch(/protocol version/);
  });

  it('rejects any additional x-awf control header', () => {
    const withExtra = [...rawHeaders, 'X-AWF-Timeout', '9999'];
    expect(buildRequestFromFrame(headers, withExtra, 'x').error).toMatch(/unsupported request control header/);
  });

  it('rejects duplicated headers so outcomes cannot be smuggled', () => {
    const duplicated = [...rawHeaders, 'X-AWF-Outcome-1', 'SNEAKY'];
    expect(buildRequestFromFrame(headers, duplicated, 'x').error).toMatch(/duplicate request header/);
  });

  function omit(name: string): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
  }

  it('rejects a missing outcome', () => {
    expect(buildRequestFromFrame(omit('x-awf-outcome-3'), rawHeaders, 'x').error)
      .toMatch(/missing outcome header/);
  });

  it('rejects a missing repository selector', () => {
    expect(buildRequestFromFrame(omit('x-awf-repo'), rawHeaders, 'x').error)
      .toMatch(/missing repository selector/);
  });
});
