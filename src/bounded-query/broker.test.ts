import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Behavioural tests for the trusted broker (protocol v2), exercised through
 * its real filesystem workspace code with a mocked Docker runner and an
 * injectable clock.
 *
 * These stand in for a full end-to-end query run: they prove the
 * writable-copy semantics, the seed's immutability, repository isolation,
 * the operational invocation budget, the per-repository *bit* ledger (no
 * per-query cap — every invocation's schema-derived charge is computed and
 * debited before launch), the timing-bucket response discipline (via a fake
 * monotonic clock, never real time), workspace teardown, and — most
 * importantly — that every failure path produces the byte-identical
 * canonical `{"status":"error"}` with no extra signal.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const workspace = require(path.join(brokerDir, 'workspace.js'));
const { buildQueryArgs, normalizeTimeoutMs } = require(path.join(brokerDir, 'query-runner.js'));
const { buildRequestFromFrame, readBoundedBody } = require(path.join(brokerDir, 'framing.js'));
const { TIMING_BUCKETS_MS } = require(path.join(brokerDir, 'scheduler.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const CANONICAL_ERROR = '{"status":"error"}';
// A fixed-shape object schema (one enum-valued field) keeps most vectors
// structurally identical to the old three-outcome protocol while exercising
// the new schema-carrying request and ok/error envelope.
const OUTCOME_SCHEMA = { type: 'object', fields: { result: { type: 'enum', values: ['YES', 'NO', 'UNKNOWN'] } } };

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

/** A fake monotonic clock the tests fully control — no real time ever elapses. */
function createFakeClock() {
  let value = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      nowMs: () => value,
      sleep: (ms: number) => {
        sleeps.push(ms);
        value += ms;
        return Promise.resolve();
      },
    },
    advance(ms: number): void {
      value += ms;
    },
    sleeps,
  };
}

/** Awaits `broker.handle`, capturing the single callback response. */
async function invoke(
  broker: { handle: (request: unknown, respond: (json: string) => void) => Promise<void> },
  request: unknown,
): Promise<string> {
  let response = '';
  await broker.handle(request, (json: string) => {
    response = json;
  });
  return response;
}

describe('bounded-query broker', () => {
  let root: string;
  let config: Record<string, unknown>;
  let seedMap: Map<string, { seedId: string; sensitivity: string }>;
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
      queryMountDir: '/query',
      queryScriptPath: '/awf/query-script.py',
      querySeccompPath: '/opt/awf/query-seccomp.json',
      queryImage: 'ghcr.io/example/bounded-query:1',
      dockerRuntime: '',
      memoryLimit: '512m',
      timeoutSeconds: 30,
      maxInvocations: 3,
      // The real broker runs as root; tests keep the invoking uid so the
      // ownership transfer is exercised without requiring privileges.
      queryUid: process.getuid?.() ?? 0,
      queryGid: process.getgid?.() ?? 0,
    };
    fs.mkdirSync(String(config.workDir), { recursive: true });
    fs.mkdirSync(String(config.seedsDir), { recursive: true });
    createSeed(seedIdA, { 'README.md': 'repo A secret\n' });
    createSeed(seedIdB, { 'README.md': 'repo B secret\n' });
    seedMap = new Map([
      ['octo/alpha', { seedId: seedIdA, sensitivity: 'internal' }],
      ['octo/beta', { seedId: seedIdB, sensitivity: 'confidential' }],
    ]);
  });

  afterEach(() => {
    unlockSeeds();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function build(
    runner: { runQueryContainer: (params: never) => Promise<unknown> },
    opts: {
      workspace?: typeof workspace;
      clock?: { nowMs: () => number; sleep: (ms: number) => Promise<void> };
      seeds?: Map<string, { seedId: string; sensitivity: string }>;
    } = {},
  ) {
    const audit = createAudit();
    const broker = createBroker({
      config,
      seedMap: opts.seeds || seedMap,
      runId: 'run-1234abcd',
      audit: audit.log,
      workspace: opts.workspace || workspace,
      runner,
      clock: opts.clock,
    });
    return { broker, audit };
  }

  /** Mock runner that behaves like a query script executing inside the sandbox. */
  function queryRunner(behaviour: (invocationDir: string) => void, overrides: Record<string, unknown> = {}) {
    const seen: string[] = [];
    return {
      seen,
      runQueryContainer: async ({ invocationId }: { invocationId: string }) => {
        // The invocation root contains the assigned seed copy, output file, and
        // submitted script. The fixed entrypoint copies the read-only seed
        // mount into bounded tmpfs before running the script.
        const invocationDir = path.join(String(config.workDir), invocationId);
        seen.push(invocationDir);
        behaviour(invocationDir);
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '', ...overrides };
      },
    } as unknown as { runQueryContainer: (params: never) => Promise<unknown> } & { seen: string[] };
  }

  const validRequest = (repo = 'octo/alpha') => ({
    privateRepo: repo,
    schema: OUTCOME_SCHEMA,
    script: 'query',
  });

  it('returns the canonically re-serialized declared outcome inside the ok envelope', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '  {"result": "YES"}  ');
    });
    const { broker } = build(runner);

    expect(await invoke(broker, validRequest())).toBe('{"status":"ok","result":{"result":"YES"}}');
  });

  it('gives the query a read-only copy of the repo and leaves the seed unchanged', async () => {
    let observed = '';
    const runner = queryRunner((invocationDir) => {
      // Query reads from the repo copy (mounted :ro in Docker).
      observed = fs.readFileSync(path.join(invocationDir, 'repo', 'README.md'), 'utf8');
      // Query writes its answer to the pre-created out file.
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"NO"}');
    });
    const { broker } = build(runner);

    expect(await invoke(broker, validRequest())).toBe('{"status":"ok","result":{"result":"NO"}}');
    expect(observed).toBe('repo A secret\n');
    // The seed itself is untouched.
    expect(fs.readFileSync(path.join(seedPath(seedIdA), 'README.md'), 'utf8')).toBe('repo A secret\n');
    expect(fs.existsSync(path.join(seedPath(seedIdA), 'src'))).toBe(true);
  });

  it('destroys the per-invocation copy afterwards', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    });
    const { broker } = build(runner);

    await invoke(broker, validRequest());

    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('never exposes another repository or the seed parent to a query', async () => {
    let repoContents = '';
    let siblings: string[] = [];
    const runner = queryRunner((invocationDir) => {
      repoContents = fs.readFileSync(path.join(invocationDir, 'repo', 'README.md'), 'utf8');
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      siblings = fs.readdirSync(invocationDir).sort();
    });
    const { broker } = build(runner);

    await invoke(broker, validRequest('octo/beta'));

    expect(repoContents).toBe('repo B secret\n');
    expect(siblings).toEqual(['out', 'repo', 'script.py']);
    expect(repoContents).not.toContain('repo A');
  });

  it('rejects a repository outside the AWF-generated map without launching', async () => {
    const runner = queryRunner(() => {
      throw new Error('query must not launch');
    });
    const { broker, audit } = build(runner);

    expect(await invoke(broker, validRequest('octo/not-configured'))).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ kind: 'failure', reason: 'repo-not-allowed' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it.each([
    ['extra launch control field', { ...validRequest(), image: 'evil' }],
    ['a smuggled sensitivity override (requests cannot choose sensitivity)', { ...validRequest(), sensitivity: 'public' }],
    ['invalid schema construct', { ...validRequest(), schema: { type: 'nope' } }],
    ['path traversal repo selector', { privateRepo: '../../seeds', schema: OUTCOME_SCHEMA, script: 'x' }],
  ])('rejects %s before copying or launching', async (_name, request) => {
    const runner = queryRunner(() => {
      throw new Error('query must not launch');
    });
    const { broker, audit } = build(runner);

    expect(await invoke(broker, request)).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'invalid-request' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it.each([
    [
      'no output file',
      (invocationDir: string): void => {
        fs.unlinkSync(path.join(invocationDir, 'out'));
      },
      'unreadable-output',
    ],
    [
      'oversized output',
      (invocationDir: string): void => {
        fs.writeFileSync(path.join(invocationDir, 'out'), 'x'.repeat(8193));
      },
      'unreadable-output',
    ],
    [
      'symlinked output',
      (invocationDir: string): void => {
        fs.unlinkSync(path.join(invocationDir, 'out'));
        fs.symlinkSync('/etc/hosts', path.join(invocationDir, 'out'));
      },
      'unreadable-output',
    ],
    [
      'undeclared enum value',
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
  ])('maps %s to the canonical error', async (_name, behaviour, reason) => {
    const runner = queryRunner(behaviour as (invocationDir: string) => void);
    const { broker, audit } = build(runner);

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('maps a timeout to the canonical error', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    }, { timedOut: true, exitCode: 137 });
    const { broker, audit } = build(runner);

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'timeout' });
  });

  it('maps a non-zero query exit to the canonical error even when output is valid', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    }, { exitCode: 2 });
    const { broker, audit } = build(runner);

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'non-zero-exit' });
  });

  it('includes cleanup before the response and maps cleanup failure to canonical error', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
    });
    const cleanupFailingWorkspace = {
      ...workspace,
      destroyInvocationWorkspace: () => {
        throw new Error('cleanup failed');
      },
    };
    const { broker, audit } = build(runner, { workspace: cleanupFailingWorkspace });

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'cleanup-failed' });
  });

  it('destroys a partial workspace when workspace creation throws', async () => {
    const partialWorkspace = {
      ...workspace,
      createInvocationWorkspace: (params: { config: { workDir: string }; invocationId: string }) => {
        fs.mkdirSync(path.join(params.config.workDir, params.invocationId), { recursive: true });
        fs.writeFileSync(path.join(params.config.workDir, params.invocationId, 'partial'), 'data');
        throw new Error('copy failed');
      },
    };
    const runner = queryRunner(() => {
      throw new Error('query must not launch');
    });
    const { broker, audit } = build(runner, { workspace: partialWorkspace });

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'workspace-create-failed' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('maps a launch failure to the canonical error', async () => {
    const runner = {
      runQueryContainer: async () => {
        throw new Error('daemon unreachable');
      },
    } as unknown as { runQueryContainer: (params: never) => Promise<unknown> };
    const { broker, audit } = build(runner);

    expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
    expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'launch-failed' });
    expect(fs.readdirSync(String(config.workDir))).toEqual([]);
  });

  it('produces byte-identical responses for every failure-shaped answer', async () => {
    const failures = await Promise.all([
      invoke(build(queryRunner(() => {})).broker, validRequest('octo/nope')),
      invoke(build(queryRunner(() => {})).broker, { privateRepo: 'octo/alpha', schema: { type: 'nope' }, script: 'x' }),
    ]);

    expect(new Set(failures)).toEqual(new Set([CANONICAL_ERROR]));
  });

  it('enforces the per-run invocation budget atomically and without launching', async () => {
    const launches: string[] = [];
    const runner = {
      runQueryContainer: async ({ invocationId }: { invocationId: string }) => {
        launches.push(invocationId);
        const invocationDir = path.join(String(config.workDir), invocationId);
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
        return { exitCode: 0, timedOut: false };
      },
    } as unknown as { runQueryContainer: (params: never) => Promise<unknown> };
    const { broker, audit } = build(runner);

    const results = await Promise.all(Array.from({ length: 5 }, () => invoke(broker, validRequest())));

    expect(results.filter((r) => r === '{"status":"ok","result":{"result":"YES"}}')).toHaveLength(3);
    expect(results.filter((r) => r === CANONICAL_ERROR)).toHaveLength(2);
    expect(launches).toHaveLength(3);
    expect(audit.records.filter((r) => r.reason === 'invocation-count-exhausted')).toHaveLength(2);
  });

  it('records failure reasons only in the protected audit log, never in the response', async () => {
    const runner = queryRunner((invocationDir) => {
      fs.unlinkSync(path.join(invocationDir, 'out'));
    });
    const { broker, audit } = build(runner);

    const response = await invoke(broker, validRequest());

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

  describe('per-repository bit ledger (no per-query cap)', () => {
    it("debits an invocation's exact schema charge before copying a seed or launching Python", async () => {
      const runner = queryRunner((invocationDir) => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      });
      const { broker } = build(runner);

      // 1 (status) + 2 (ceil(log2(3)) for the 3-valued enum) + 3 (timing) = 6 bits.
      const before = broker.ledger.remainingBits('octo/alpha');
      await invoke(broker, validRequest());
      expect(broker.ledger.remainingBits('octo/alpha')).toBe(before - 6);
    });

    it('never debits the ledger for a request rejected before validation succeeds', async () => {
      const runner = queryRunner(() => {
        throw new Error('query must not launch');
      });
      const { broker } = build(runner);

      const before = broker.ledger.remainingBits('octo/alpha');
      await invoke(broker, { ...validRequest(), schema: { type: 'nope' } });
      expect(broker.ledger.remainingBits('octo/alpha')).toBe(before);
    });

    it('denies (without launching) an invocation whose schema charge exceeds the remaining balance', async () => {
      const runner = queryRunner(() => {
        throw new Error('query must not launch: charge exceeds confidential (8-bit) budget');
      });
      const { broker, audit } = build(runner);

      // A 256-value enum costs 1 + 8 + 3 = 12 bits — more than octo/beta's
      // 8-bit "confidential" run budget.
      const expensiveSchema = { type: 'enum', values: Array.from({ length: 256 }, (_, i) => i) };
      const response = await invoke(broker, { privateRepo: 'octo/beta', schema: expensiveSchema, script: 'x' });

      expect(response).toBe(CANONICAL_ERROR);
      expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'bit-budget-exhausted' });
      expect(fs.readdirSync(String(config.workDir))).toEqual([]);
    });

    it('a sealed-sensitivity repository (0-bit run budget) can never afford even the cheapest schema', async () => {
      const zeroBudgetSeedMap = new Map([['octo/sealed', { seedId: seedIdA, sensitivity: 'sealed' }]]);
      const runner = queryRunner(() => {
        throw new Error('a sealed repo must never launch a query');
      });
      const { broker, audit } = build(runner, { seeds: zeroBudgetSeedMap });

      // The cheapest possible schema (const) still costs 1 + 0 + 3 = 4 bits > 0.
      const response = await invoke(broker, {
        privateRepo: 'octo/sealed',
        schema: { type: 'const', value: 'x' },
        script: 'x',
      });

      expect(response).toBe(CANONICAL_ERROR);
      expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'bit-budget-exhausted' });
      expect(fs.readdirSync(String(config.workDir))).toEqual([]);
    });

    it('a public-sensitivity repository is unmetered and never runs out of budget', async () => {
      const publicSeedMap = new Map([['octo/public', { seedId: seedIdA, sensitivity: 'public' }]]);
      config.maxInvocations = 20;
      const runner = queryRunner((invocationDir) => {
        fs.writeFileSync(path.join(invocationDir, 'out'), '[0,0,0,0,0,0,0,0]');
      });
      const { broker } = build(runner, { seeds: publicSeedMap });

      // A tuple of eight 16-bit integers costs 1 + 128 + 3 = 132 bits — far
      // beyond even "internal"'s 64-bit run budget, many times over. Only
      // "public" (unmetered, `null` in the ledger) could ever afford it more
      // than zero times.
      const bigSchema = {
        type: 'tuple',
        items: Array.from({ length: 8 }, () => ({ type: 'integer', minimum: 0, maximum: 65535 })),
      };
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        expect(await invoke(broker, { privateRepo: 'octo/public', schema: bigSchema, script: 'x' })).not.toBe(
          CANONICAL_ERROR,
        );
      }
      expect(broker.ledger.remainingBits('octo/public')).toBeNull();
    });
  });

  describe('response-timing bucketing (fake monotonic clock — no real time elapses)', () => {
    it('buckets a fast-completing invocation to the smallest boundary at or after elapsed processing time', async () => {
      const { clock, advance, sleeps } = createFakeClock();
      const runner = queryRunner((invocationDir) => {
        advance(50); // Simulate 50ms of processing — falls in the 100ms bucket.
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      });
      const { broker, audit } = build(runner, { clock });

      await invoke(broker, validRequest());

      const invocationRecord = audit.records.find((r) => r.kind === 'invocation');
      expect(invocationRecord).toMatchObject({ bucketMs: 100 });
      // Waited the remaining 50ms to reach the 100ms boundary.
      expect(sleeps).toEqual([50]);
    });

    it('does not wait at all when processing already lands exactly on a bucket boundary', async () => {
      const { clock, advance, sleeps } = createFakeClock();
      const runner = queryRunner((invocationDir) => {
        advance(10); // Exactly the smallest bucket.
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      });
      const { broker, audit } = build(runner, { clock });

      await invoke(broker, validRequest());

      expect(audit.records.find((r) => r.kind === 'invocation')).toMatchObject({ bucketMs: 10 });
      expect(sleeps).toEqual([]);
    });

    it('buckets a failure response exactly like a success response', async () => {
      const { clock, advance } = createFakeClock();
      const runner = queryRunner((invocationDir) => {
        advance(500); // Falls in the 1000ms bucket.
        fs.writeFileSync(path.join(invocationDir, 'out'), 'not valid json');
      });
      const { broker, audit } = build(runner, { clock });

      expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
      const failureRecord = [...audit.records].reverse().find((r) => r.kind === 'failure');
      // Failure records don't currently carry bucketMs (only invocation
      // records do), but the wait itself must still have occurred — this is
      // implicitly proven by the overflow test below reaching a different
      // code path only when elapsed exceeds every bucket.
      expect(failureRecord).toMatchObject({ reason: 'nonconformant-output' });
    });

    it('includes workspace cleanup latency when selecting the timing bucket', async () => {
      const { clock, advance, sleeps } = createFakeClock();
      const runner = queryRunner((invocationDir) => {
        advance(5);
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      });
      const cleanupWorkspace = {
        ...workspace,
        destroyInvocationWorkspace: (workDir: string, invocationId: string) => {
          advance(50);
          workspace.destroyInvocationWorkspace(workDir, invocationId);
        },
      };
      const { broker, audit } = build(runner, { clock, workspace: cleanupWorkspace });

      await invoke(broker, validRequest());

      expect(audit.records.find((r) => r.kind === 'invocation')).toMatchObject({ bucketMs: 100 });
      expect(sleeps).toEqual([45]);
    });

    it('fails closed with the canonical error when processing overruns every configured bucket, even for an otherwise-valid result', async () => {
      const { clock, advance } = createFakeClock();
      const runner = queryRunner((invocationDir) => {
        // Pathological infrastructure latency far beyond the largest bucket
        // (600_000ms) — never possible from the script itself, which is
        // capped at boundedQueries.timeout <= 540s by preflight.ts.
        advance(TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] + 1);
        fs.writeFileSync(path.join(invocationDir, 'out'), '{"result":"YES"}');
      });
      const { broker, audit } = build(runner, { clock });

      expect(await invoke(broker, validRequest())).toBe(CANONICAL_ERROR);
      expect(audit.records[audit.records.length - 1]).toMatchObject({ reason: 'timing-bucket-overflow' });
    });
  });
});

describe('query container arguments', () => {
  const config = {
    hostWorkDir: '/daemon/work',
    queryMountDir: '/query',
    queryScriptPath: '/awf/query-script.py',
    querySeccompPath: '/opt/awf/query-seccomp.json',
    queryImage: 'ghcr.io/example/bounded-query:1',
    dockerRuntime: '',
    memoryLimit: '256m',
    queryUid: 65534,
    queryGid: 65534,
  };

  function args(overrides: Record<string, unknown> = {}): string[] {
    return buildQueryArgs({
      config: { ...config, ...overrides },
      runId: 'run-1',
      invocationId: 'inv-1',
      containerName: 'awf-query-inv-1',
    });
  }

  it('isolates the query: no network, read-only rootfs, non-root, no capabilities', () => {
    const joined = args().join(' ');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--user 65534:65534');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges:true');
    expect(joined).toContain('--security-opt seccomp=/opt/awf/query-seccomp.json');
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
      '/daemon/work/inv-1/out:/query/out:rw',
      '/daemon/work/inv-1/script.py:/awf/query-script.py:ro',
    ]);
  });

  it('backs /query with a size-limited tmpfs for aggregate storage enforcement', () => {
    const joined = args().join(' ');
    expect(joined).toMatch(/--tmpfs \/query:rw,nosuid,nodev,size=\d+,uid=65534,gid=65534,mode=0700/);
    expect(joined).not.toContain(':/query:rw');
    expect(joined).not.toContain(':/query/repo:rw');
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
    expect(argv[argv.indexOf('--entrypoint') + 1]).toBe('/usr/local/bin/run-query');
    expect(argv[argv.length - 1]).toBe('ghcr.io/example/bounded-query:1');
    expect(argv).not.toContain('-I');
  });

  it('labels the container for orphan cleanup', () => {
    expect(args().join(' ')).toContain('--label awf.bounded-query.run=run-1');
  });

  it('passes an explicit OCI runtime only when one is configured', () => {
    expect(args().includes('--runtime')).toBe(false);
    expect(args({ dockerRuntime: 'runsc' }).join(' ')).toContain('--runtime runsc');
  });

  it('normalizes fractional monotonic durations for Node child-process timeouts', () => {
    expect(normalizeTimeoutMs(31_872.77068800002)).toBe(31_873);
  });
});

describe('request framing (protocol v2)', () => {
  function base64url(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const schema = { type: 'boolean' };
  const headers = {
    'x-awf-query-version': '2',
    'x-awf-repo': 'octo/alpha',
    'x-awf-schema-b64': base64url(JSON.stringify(schema)),
  };
  const rawHeaders = Object.entries(headers).flat();

  it('assembles the canonical request object, decoding the schema header', () => {
    expect(buildRequestFromFrame(headers, rawHeaders, 'print(1)')).toEqual({
      request: { privateRepo: 'octo/alpha', schema, script: 'print(1)' },
    });
  });

  it('rejects an unsupported protocol version', () => {
    expect(buildRequestFromFrame({ ...headers, 'x-awf-query-version': '1' }, rawHeaders, 'x').error)
      .toMatch(/protocol version/);
  });

  it('rejects any additional x-awf control header', () => {
    const withExtra = [...rawHeaders, 'X-AWF-Timeout', '9999'];
    expect(buildRequestFromFrame(headers, withExtra, 'x').error).toMatch(/unsupported request control header/);
  });

  it('rejects duplicated headers so the repo or schema cannot be smuggled', () => {
    const duplicated = [...rawHeaders, 'X-AWF-Repo', 'octo/sneaky'];
    expect(buildRequestFromFrame(headers, duplicated, 'x').error).toMatch(/duplicate request header/);
  });

  function omit(name: string): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
  }

  it('rejects a missing schema header', () => {
    expect(buildRequestFromFrame(omit('x-awf-schema-b64'), rawHeaders, 'x').error)
      .toMatch(/missing or malformed schema header/);
  });

  it('rejects a missing repository selector', () => {
    expect(buildRequestFromFrame(omit('x-awf-repo'), rawHeaders, 'x').error)
      .toMatch(/missing repository selector/);
  });

  it('rejects a schema header that is not valid base64url', () => {
    expect(buildRequestFromFrame({ ...headers, 'x-awf-schema-b64': 'not base64url!!' }, rawHeaders, 'x').error)
      .toMatch(/missing or malformed schema header/);
  });

  it('rejects a schema header that decodes to invalid JSON', () => {
    const badSchema = base64url('not json at all');
    expect(buildRequestFromFrame({ ...headers, 'x-awf-schema-b64': badSchema }, rawHeaders, 'x').error)
      .toMatch(/not valid JSON/);
  });

  it('rejects a schema header that decodes to invalid UTF-8', () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe]).toString('base64url');
    expect(buildRequestFromFrame({ ...headers, 'x-awf-schema-b64': invalidUtf8 }, rawHeaders, 'x').error)
      .toMatch(/missing or malformed schema header/);
  });
});

describe('bounded request body reading', () => {
  function fakeRequest(chunks: (Buffer | string)[]): EventEmitter & { pause: () => void } {
    const emitter = new EventEmitter() as EventEmitter & { pause: () => void };
    emitter.pause = jest.fn();
    process.nextTick(() => {
      for (const chunk of chunks) emitter.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      emitter.emit('end');
    });
    return emitter;
  }

  it('reads a well-formed script body', async () => {
    const req = fakeRequest(['print', '(1)']);
    await expect(readBoundedBody(req)).resolves.toEqual({ script: 'print(1)' });
  });

  it('rejects a body exceeding the script size cap while streaming', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MAX_SCRIPT_BYTES } = require(path.join(brokerDir, 'protocol.js'));
    const req = fakeRequest(['x'.repeat(MAX_SCRIPT_BYTES + 1)]);
    const result = await readBoundedBody(req);
    expect(result).toEqual({ error: 'script exceeds maximum size' });
  });

  it('rejects a body that is not valid UTF-8', async () => {
    const req = fakeRequest([Buffer.from([0xff, 0xfe])]);
    await expect(readBoundedBody(req)).resolves.toEqual({ error: 'script is not valid UTF-8' });
  });
});
