import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const {
  createEnclaveRunner,
  deriveEnclaveContainerSpec,
} = require(path.join(brokerDir, 'enclave-runner.js'));
const { DockerEnclaveRunner } = require(path.join(brokerDir, 'docker-enclave-runner.js'));
const { GvisorEnclaveRunner } = require(path.join(brokerDir, 'gvisor-enclave-runner.js'));
const { SbxEnclaveRunner } = require(path.join(brokerDir, 'sbx-enclave-runner.js'));
const { createLedger } = require(path.join(brokerDir, 'ledger.js'));
const { CANONICAL_ERROR_JSON } = require(path.join(brokerDir, 'protocol.js'));
const { BOUNDED_AGENT_AUDIT_FILENAME } = require(path.join(brokerDir, 'audit.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const SEED_ID = 'a'.repeat(32);
const RUN_ID = 'b'.repeat(32);

const config = {
  workDir: '/srv/awf/work',
  seedsDir: '/srv/awf/seeds',
  hostWorkDir: '/var/tmp/private/work',
  hostSeedsDir: '/var/tmp/private/seeds',
  enclaveImage: 'ghcr.io/github/gh-aw-firewall/bounded-agent:latest',
  enclaveSeccompPath: '/opt/awf/enclave-seccomp.json',
  enclaveMountDir: '/agent',
  enclaveSeedPath: '/awf/seed',
  enclaveTaskPath: '/awf/task.txt',
  enclaveSchemaPath: '/awf/schema.json',
  enclaveUid: 65534,
  enclaveGid: 65534,
  backend: 'docker',
  profile: 'openai',
  model: 'gpt-4o-mini',
  apiEndpoint: 'http://172.31.0.30:10000',
  network: 'awf-bounded-agent',
  timeoutSeconds: 120,
  memoryLimit: '512m',
  tmpfsLimit: '64m',
  cpuLimit: '1',
  pidsLimit: 128,
  maxOutputBytes: 8192,
  maxTaskBytes: 4096,
  maxInvocations: 8,
  maxModelRequests: 8,
  maxModelTokens: 1024,
};

const booleanSchema = { type: 'boolean' };

function makeAudit() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    invocation: (record: Record<string, unknown>) => records.push({ kind: 'invocation', ...record }),
    failure: (invocationId: string, reason: string, detail?: string) =>
      records.push({ kind: 'failure', invocationId, reason, detail }),
    lifecycle: (event: string, detail?: unknown) => records.push({ kind: 'lifecycle', event, detail }),
  };
}

function makeClock() {
  let now = 0;
  return {
    nowMs: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

interface WorkspaceStub {
  created: string[];
  destroyed: string[];
  output: string | undefined;
  createInvocationWorkspace: (params: Record<string, unknown>) => Record<string, unknown>;
  readEnclaveOutput: (outPath: string, maxOutputBytes: number) => string | undefined;
  destroyInvocationWorkspace: (workDir: string, invocationId: string) => void;
}

function makeWorkspace(output: string | undefined = 'true'): WorkspaceStub {
  const stub: WorkspaceStub = {
    created: [],
    destroyed: [],
    output,
    createInvocationWorkspace: (params) => {
      stub.created.push(params.invocationId as string);
      return { outPath: `/srv/awf/work/${params.invocationId}/out` };
    },
    readEnclaveOutput: () => stub.output,
    destroyInvocationWorkspace: (_workDir, invocationId) => {
      stub.destroyed.push(invocationId);
    },
  };
  return stub;
}

/** Simulates a missing/oversized/non-regular result file. */
function makeMissingOutputWorkspace(): WorkspaceStub {
  const stub = makeWorkspace();
  stub.output = undefined;
  return stub;
}

function makeRunner(overrides: Record<string, unknown> = {}) {
  return {
    launches: [] as Array<Record<string, unknown>>,
    assertAvailable: async () => undefined,
    reconcileRun: async () => undefined,
    runEnclaveContainer: async function (params: Record<string, unknown>) {
      (this.launches as Array<Record<string, unknown>>).push(params);
      return { exitCode: 0, timedOut: false };
    },
    ...overrides,
  };
}

function seedMap(sensitivity = 'internal'): Map<string, { seedId: string; sensitivity: string }> {
  return new Map([['octo/alpha', { seedId: SEED_ID, sensitivity }]]);
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { privateRepo: 'octo/alpha', schema: booleanSchema, task: 'is it true?', ...overrides };
}

async function invoke(broker: any, req: unknown): Promise<string> {
  let response = '';
  await broker.handle(req, (json: string) => {
    response = json;
  });
  return response;
}

describe('bounded-agent broker', () => {
  it('returns a canonical success envelope for a conforming result', async () => {
    const workspace = makeWorkspace('true');
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner(),
      workspace,
      clock: makeClock(),
    });

    expect(await invoke(broker, request())).toBe('{"status":"ok","result":true}');
  });

  it('collapses every failure class to the identical canonical error', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['invalid-request', { workspace: makeWorkspace('true'), req: request({ image: 'evil' }) }],
      ['repo-not-allowed', { workspace: makeWorkspace('true'), req: request({ privateRepo: 'octo/beta' }) }],
      ['nonconformant-output', { workspace: makeWorkspace('"nope"'), req: request() }],
      ['unreadable-output', { workspace: makeMissingOutputWorkspace(), req: request() }],
    ];

    for (const [, params] of cases) {
      const broker = createBroker({
        config,
        seedMap: seedMap(),
        runId: RUN_ID,
        audit: makeAudit(),
        runner: makeRunner(),
        workspace: params.workspace as WorkspaceStub,
        clock: makeClock(),
      });
      expect(await invoke(broker, params.req)).toBe(CANONICAL_ERROR_JSON);
    }
  });

  it('maps a timed-out enclave to the canonical error', async () => {
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner({ runEnclaveContainer: async () => ({ exitCode: 0, timedOut: true }) }),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
    });
    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
  });

  it('maps a non-zero enclave exit to the canonical error without exposing it', async () => {
    const audit = makeAudit();
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit,
      runner: makeRunner({ runEnclaveContainer: async () => ({ exitCode: 42, timedOut: false }) }),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
    });
    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
    expect(audit.records).toEqual([
      expect.objectContaining({ kind: 'failure', reason: 'non-zero-exit' }),
    ]);
    expect(audit.records[0]).not.toHaveProperty('exitCode');
    expect(audit.records[0].detail).toBeUndefined();
  });

  it('debits the sensitivity budget before any workspace or container exists', async () => {
    const workspace = makeWorkspace('true');
    const runner = makeRunner();
    // `sealed` is a 0-bit budget, so even the cheapest schema is unaffordable.
    const broker = createBroker({
      config,
      seedMap: seedMap('sealed'),
      runId: RUN_ID,
      audit: makeAudit(),
      runner,
      workspace,
      clock: makeClock(),
    });

    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
    expect(workspace.created).toEqual([]);
    expect(runner.launches).toEqual([]);
  });

  it('charges the status and timing channels, not just the schema payload', async () => {
    const ledger = createLedger(seedMap('confidential'));
    const broker = createBroker({
      config,
      seedMap: seedMap('confidential'),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner(),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
      ledger,
    });

    // confidential = 8 bits/run; a boolean costs 1 (status) + 1 (payload) + 3 (timing) = 5.
    await invoke(broker, request());
    expect(ledger.remainingBits('octo/alpha')).toBe(3);
    // The second identical request no longer fits.
    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
    expect(ledger.remainingBits('octo/alpha')).toBe(3);
  });

  it('never refunds a committed charge, even when the enclave fails', async () => {
    const ledger = createLedger(seedMap('confidential'));
    const broker = createBroker({
      config,
      seedMap: seedMap('confidential'),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner({ runEnclaveContainer: async () => ({ exitCode: 1, timedOut: false }) }),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
      ledger,
    });

    await invoke(broker, request());
    expect(ledger.remainingBits('octo/alpha')).toBe(3);
  });

  it('keeps a ledger separate from any other bounded subsystem', async () => {
    const agentLedger = createLedger(seedMap('confidential'));
    const queryLedger = createLedger(seedMap('confidential'));
    const broker = createBroker({
      config,
      seedMap: seedMap('confidential'),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner(),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
      ledger: agentLedger,
    });

    await invoke(broker, request());
    expect(agentLedger.remainingBits('octo/alpha')).toBe(3);
    // A sibling subsystem's ledger is untouched.
    expect(queryLedger.remainingBits('octo/alpha')).toBe(8);
  });

  it('enforces the per-run invocation cap on every response, including rejections', async () => {
    const runner = makeRunner();
    const broker = createBroker({
      config: { ...config, maxInvocations: 2 },
      seedMap: seedMap('public'),
      runId: RUN_ID,
      audit: makeAudit(),
      runner,
      workspace: makeWorkspace('true'),
      clock: makeClock(),
    });

    // A rejected request still consumes one unit.
    expect(await invoke(broker, request({ image: 'evil' }))).toBe(CANONICAL_ERROR_JSON);
    expect(await invoke(broker, request())).toBe('{"status":"ok","result":true}');
    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
    expect(runner.launches).toHaveLength(1);
  });

  it('destroys the workspace before responding', async () => {
    const workspace = makeWorkspace('true');
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner(),
      workspace,
      clock: makeClock(),
    });

    await invoke(broker, request());
    expect(workspace.destroyed).toEqual(workspace.created);
  });

  it('fails closed when workspace teardown fails', async () => {
    const workspace = makeWorkspace('true');
    workspace.destroyInvocationWorkspace = () => {
      throw new Error('EBUSY');
    };
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner(),
      workspace,
      clock: makeClock(),
    });

    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
  });

  it('holds the response until a fixed timing bucket boundary', async () => {
    const clock = makeClock();
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner: makeRunner({
        runEnclaveContainer: async () => {
          clock.advance(37);
          return { exitCode: 0, timedOut: false };
        },
      }),
      workspace: makeWorkspace('true'),
      clock,
    });

    await invoke(broker, request());
    // 37ms of work is padded to the 100ms bucket.
    expect(clock.nowMs()).toBe(100);
  });

  it('records the sensitivity class and charge but never the repository or task', async () => {
    const audit = makeAudit();
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit,
      runner: makeRunner(),
      workspace: makeWorkspace('true'),
      clock: makeClock(),
    });

    await invoke(broker, request({ task: 'SECRET-TASK-MARKER' }));
    const serialized = JSON.stringify(audit.records);
    expect(serialized).toContain('"sensitivity":"internal"');
    expect(serialized).not.toContain('octo/alpha');
    expect(serialized).not.toContain('SECRET-TASK-MARKER');
    expect(serialized).not.toContain('/srv/awf/work');
  });

  it('stops admitting invocations after close()', async () => {
    const runner = makeRunner();
    const broker = createBroker({
      config,
      seedMap: seedMap(),
      runId: RUN_ID,
      audit: makeAudit(),
      runner,
      workspace: makeWorkspace('true'),
      clock: makeClock(),
    });

    broker.close();
    expect(await invoke(broker, request())).toBe(CANONICAL_ERROR_JSON);
    expect(runner.launches).toEqual([]);
  });
});

describe('bounded-agent protected audit', () => {
  it('writes to a file distinct from the bounded-query audit trail', () => {
    expect(BOUNDED_AGENT_AUDIT_FILENAME).toBe('bounded-agent.jsonl');
  });
});

describe('bounded-agent enclave container spec', () => {
  const spec = deriveEnclaveContainerSpec({
    config,
    runId: RUN_ID,
    invocationId: 'c'.repeat(24),
    seedId: SEED_ID,
  });
  const args: string[] = [...spec.launchArgs];

  const flagValues = (flag: string): string[] =>
    args.reduce<string[]>((acc, value, index) => {
      if (value === flag && index + 1 < args.length) acc.push(args[index + 1]);
      return acc;
    }, []);

  it('joins only the dedicated bounded-agent network', () => {
    expect(flagValues('--network')).toEqual(['awf-bounded-agent']);
    expect(args).not.toContain('awf-net');
    expect(args).not.toContain('awf-ext');
  });

  it('mounts the repository read-only and never writable', () => {
    expect(flagValues('-v')).toContain(`/var/tmp/private/seeds/${SEED_ID}:/awf/seed:ro`);
    expect(args).toContain('--read-only');
  });

  it('mounts the task and schema read-only and the result file read-write', () => {
    const volumes = flagValues('-v');
    expect(volumes).toContain(`/var/tmp/private/work/${'c'.repeat(24)}/task.txt:/awf/task.txt:ro`);
    expect(volumes).toContain(`/var/tmp/private/work/${'c'.repeat(24)}/schema.json:/awf/schema.json:ro`);
    expect(volumes).toContain(`/var/tmp/private/work/${'c'.repeat(24)}/out:/agent/out:rw`);
    expect(volumes).toHaveLength(4);
  });

  it('never mounts the Docker socket, the workspace, or host state into the enclave', () => {
    const volumes = flagValues('-v').join(' ');
    expect(volumes).not.toContain('docker.sock');
    expect(volumes).not.toContain('/host');
    expect(volumes).not.toContain('seed-map.json');
    expect(args).not.toContain('--privileged');
  });

  it('applies bounded tmpfs mounts for work, result, and /tmp', () => {
    const tmpfs = flagValues('--tmpfs');
    expect(tmpfs).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m');
    expect(tmpfs).toContain('/agent:rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700');
  });

  it('runs as a fixed non-root uid/gid with all capabilities dropped', () => {
    expect(flagValues('--user')).toEqual(['65534:65534']);
    expect(flagValues('--cap-drop')).toEqual(['ALL']);
    expect(flagValues('--security-opt')).toEqual([
      'no-new-privileges:true',
      'seccomp=/opt/awf/enclave-seccomp.json',
    ]);
  });

  it('bounds memory, cpu, pids, and file size', () => {
    expect(flagValues('--memory')).toEqual(['512m']);
    expect(flagValues('--memory-swap')).toEqual(['512m']);
    expect(flagValues('--cpus')).toEqual(['1']);
    expect(flagValues('--pids-limit')).toEqual(['128']);
    expect(flagValues('--ulimit')).toEqual([`fsize=${32 * 1024 * 1024}`, 'nofile=1024:1024']);
  });

  it('never pulls and always uses a fresh uniquely named labelled container', () => {
    expect(flagValues('--pull')).toEqual(['never']);
    expect(spec.containerName).toBe(`awf-bounded-agent-${RUN_ID.slice(0, 12)}-${'c'.repeat(24)}`);
    expect(flagValues('--label')).toEqual([
      `awf.bounded-agent.run=${RUN_ID}`,
      `awf.bounded-agent.invocation=${'c'.repeat(24)}`,
    ]);
  });

  it('passes only the fixed trusted enclave environment', () => {
    expect(flagValues('--env').sort()).toEqual([
      'AWF_BOUNDED_AGENT_API_ENDPOINT=http://172.31.0.30:10000',
      'AWF_BOUNDED_AGENT_DEADLINE_SECONDS=120',
      'AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS=8',
      'AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS=1024',
      'AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES=8192',
      'AWF_BOUNDED_AGENT_MODEL=gpt-4o-mini',
      'AWF_BOUNDED_AGENT_PROFILE=openai',
      'HOME=/tmp',
      'PYTHONDONTWRITEBYTECODE=1',
      'PYTHONUNBUFFERED=1',
    ]);
  });

  it('never leaks a credential, token, or proxy setting into the enclave environment', () => {
    const envNames = flagValues('--env').map((entry) => entry.split('=')[0]);
    for (const name of envNames) {
      expect(name).not.toMatch(/API_KEY|_TOKEN$|^GH_|^GITHUB_|AUTHORIZATION|SECRET|CREDENTIAL/i);
      expect(name).not.toMatch(/^(?:HTTP|HTTPS|NO)_PROXY$/i);
    }
  });

  it('uses the fixed AWF-authored entrypoint', () => {
    expect(args.slice(-3)).toEqual([
      '--entrypoint',
      '/usr/local/bin/run-bounded-agent',
      'ghcr.io/github/gh-aw-firewall/bounded-agent:latest',
    ]);
  });

  it('adds --runtime runsc only for the gVisor backend', () => {
    expect(args).not.toContain('--runtime');
    const gvisorArgs: string[] = [
      ...deriveEnclaveContainerSpec({
        config,
        runId: RUN_ID,
        invocationId: 'c'.repeat(24),
        seedId: SEED_ID,
        runtimeName: 'runsc',
      }).launchArgs,
    ];
    expect(gvisorArgs).toContain('--runtime');
    expect(gvisorArgs[gvisorArgs.indexOf('--runtime') + 1]).toBe('runsc');
  });

  it('rejects any other OCI runtime', () => {
    expect(() =>
      deriveEnclaveContainerSpec({
        config,
        runId: RUN_ID,
        invocationId: 'c'.repeat(24),
        seedId: SEED_ID,
        runtimeName: 'kata',
      }),
    ).toThrow(/Unsupported OCI runtime/);
  });

  it('rejects identifiers that are not broker-generated', () => {
    for (const bad of ['../escape', 'UPPER', 'has space', '']) {
      expect(() =>
        deriveEnclaveContainerSpec({ config, runId: RUN_ID, invocationId: bad, seedId: SEED_ID }),
      ).toThrow(/broker-generated identifier/);
    }
    expect(() =>
      deriveEnclaveContainerSpec({
        config,
        runId: RUN_ID,
        invocationId: 'c'.repeat(24),
        seedId: '../../etc',
      }),
    ).toThrow(/AWF-generated seed identifier/);
  });

  it('freezes the argument vector', () => {
    expect(Object.isFrozen(spec.launchArgs)).toBe(true);
  });
});

describe('bounded-agent enclave runner selection', () => {
  const dockerStub = (results: Record<string, { exitCode: number; stdout?: string }>) => ({
    calls: [] as string[][],
    runDocker: async function (args: string[]) {
      (this.calls as string[][]).push(args);
      const key = `${args[0]} ${args[1] ?? ''}`.trim();
      const result = results[key] ?? results[args[0]] ?? { exitCode: 0 };
      return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: '', timedOut: false };
    },
  });

  it('selects the Docker runner for the docker backend', () => {
    expect(createEnclaveRunner(config)).toBeInstanceOf(DockerEnclaveRunner);
  });

  it('selects the gVisor runner for the gvisor backend', () => {
    expect(createEnclaveRunner({ ...config, backend: 'gvisor' })).toBeInstanceOf(GvisorEnclaveRunner);
  });

  it('selects the sbx runner for the sbx backend, which fails closed on assertAvailable', () => {
    const runner = createEnclaveRunner({ ...config, backend: 'sbx' });
    expect(runner).toBeInstanceOf(SbxEnclaveRunner);
  });

  it('fails closed for any other backend, not sbx', () => {
    expect(() => createEnclaveRunner({ ...config, backend: 'firecracker' })).toThrow(/Unsupported/);
  });

  it('requires the enclave image and the dedicated network to already exist', async () => {
    const missingImage = dockerStub({ 'image inspect': { exitCode: 1 } });
    await expect(
      new DockerEnclaveRunner(config, { docker: missingImage }).assertAvailable(),
    ).rejects.toThrow(/image is not available/);

    const missingNetwork = dockerStub({
      'image inspect': { exitCode: 0 },
      'network inspect': { exitCode: 1 },
    });
    await expect(
      new DockerEnclaveRunner(config, { docker: missingNetwork }).assertAvailable(),
    ).rejects.toThrow(/bounded-agent network is not available/);
  });

  it('requires an exactly registered runsc for the gVisor runner', async () => {
    const withoutRunsc = dockerStub({
      'image inspect': { exitCode: 0 },
      'network inspect': { exitCode: 0 },
      'info --format': { exitCode: 0, stdout: 'runc\n' },
      info: { exitCode: 0, stdout: 'runc\n' },
    });
    await expect(
      new GvisorEnclaveRunner(config, { docker: withoutRunsc }).assertAvailable(),
    ).rejects.toThrow(/no fallback is permitted/);

    const withRunsc = dockerStub({
      'image inspect': { exitCode: 0 },
      'network inspect': { exitCode: 0 },
      info: { exitCode: 0, stdout: 'runc\nrunsc\n' },
    });
    await expect(
      new GvisorEnclaveRunner(config, { docker: withRunsc }).assertAvailable(),
    ).resolves.toBeUndefined();
  });

  it('deterministically removes every container labelled with this run', async () => {
    const docker = dockerStub({ ps: { exitCode: 0, stdout: 'abcdef123456\n' } });
    const runner = new DockerEnclaveRunner(config, { docker });
    await runner.reconcileRun(RUN_ID);

    const listed = docker.calls.find((args) => args[0] === 'ps');
    expect(listed).toEqual(['ps', '-aq', '--filter', `label=awf.bounded-agent.run=${RUN_ID}`]);
    expect(docker.calls).toContainEqual(['rm', '-f', 'abcdef123456']);
  });

  it('removes the invocation container before returning and discards its streams', async () => {
    const docker = dockerStub({
      run: { exitCode: 0, stdout: 'CHATTY ENCLAVE OUTPUT' },
      ps: { exitCode: 0, stdout: 'abcdef123456\n' },
    });
    const runner = new DockerEnclaveRunner(config, { docker });
    const result = await runner.runEnclaveContainer({
      runId: RUN_ID,
      invocationId: 'c'.repeat(24),
      seedId: SEED_ID,
      timeoutMs: 1000,
    });

    expect(result).toEqual({ exitCode: 0, timedOut: false });
    expect(JSON.stringify(result)).not.toContain('CHATTY');
    expect(docker.calls.some((args) => args[0] === 'rm')).toBe(true);
  });

  it('fails closed when cleanup fails after an interrupted enclave', async () => {
    const docker = {
      runDocker: async (args: string[]) => {
        if (args[0] === 'run') return { exitCode: 0, stdout: '', stderr: '', timedOut: true };
        if (args[0] === 'ps') return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const runner = new DockerEnclaveRunner(config, { docker });
    await expect(
      runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: 'c'.repeat(24),
        seedId: SEED_ID,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/reconcile bounded-agent containers/);
  });

  it('fails closed when cleanup fails after a successful enclave', async () => {
    const docker = {
      runDocker: async (args: string[]) => {
        if (args[0] === 'run') return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        if (args[0] === 'ps') return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const runner = new DockerEnclaveRunner(config, { docker });
    await expect(
      runner.runEnclaveContainer({
        runId: RUN_ID,
        invocationId: 'c'.repeat(24),
        seedId: SEED_ID,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/reconcile bounded-agent containers/);
  });
});
