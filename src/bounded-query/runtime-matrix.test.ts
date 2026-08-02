import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOUNDED_QUERY_RUNTIME_BACKENDS,
  evaluateBoundedQueryRuntimeCombination,
  resolveBoundedQueryPrimaryBackend,
  serializeBoundedQueryRuntimeTelemetry,
  type BoundedQueryPrimaryBackend,
  type BoundedQueryRuntimeCapabilities,
} from './runtime-matrix';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const { createQueryRunner } = require(path.join(brokerDir, 'query-runner.js'));
const { createRuntimeTelemetry } = require(path.join(brokerDir, 'runtime-telemetry.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const CANONICAL_ERROR = '{"status":"error"}';
const CANONICAL_OK = '{"status":"ok","result":true}';
const BOOLEAN_SCHEMA = { type: 'boolean' };
const PRIMARY_BACKENDS = BOUNDED_QUERY_RUNTIME_BACKENDS;
const QUERY_BACKENDS = BOUNDED_QUERY_RUNTIME_BACKENDS;

const deterministicCapabilities: BoundedQueryRuntimeCapabilities = {
  primary: {
    docker: 'supported',
    gvisor: 'supported',
    sbx: 'supported',
  },
  query: {
    docker: 'supported',
    gvisor: 'supported',
    sbx: 'blocked',
  },
};

const combinations = PRIMARY_BACKENDS.flatMap((primaryBackend) =>
  QUERY_BACKENDS.map((queryBackend) => ({ primaryBackend, queryBackend })));
const executableCombinations = combinations.filter(({ primaryBackend, queryBackend }) =>
  evaluateBoundedQueryRuntimeCombination(primaryBackend, queryBackend, deterministicCapabilities).supported);
const blockedCombinations = combinations.filter(({ primaryBackend, queryBackend }) =>
  !evaluateBoundedQueryRuntimeCombination(primaryBackend, queryBackend, deterministicCapabilities).supported);

interface HarnessOptions {
  maxInvocations?: number;
  sensitivity?: 'public' | 'internal' | 'confidential';
  output?: string;
  runnerResult?: { exitCode: number; timedOut: boolean };
  processingMs?: number;
}

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

function createHarness(
  primaryBackend: BoundedQueryPrimaryBackend,
  queryBackend: 'docker' | 'gvisor',
  options: HarnessOptions = {},
) {
  const outputs = new Map<string, string>();
  const launches: Array<Record<string, unknown>> = [];
  const destroyed: string[] = [];
  const telemetry: Array<Record<string, string>> = [];
  let now = 0;
  const sleeps: number[] = [];
  const config = {
    primaryBackend,
    queryBackend,
    workDir: '/broker/private/work',
    timeoutSeconds: 30,
    maxInvocations: options.maxInvocations ?? 8,
  };
  const workspace = {
    createInvocationWorkspace: ({
      invocationId,
      seedId,
      script,
    }: {
      invocationId: string;
      seedId: string;
      script: string;
    }) => {
      expect(seedId).toBe('a'.repeat(32));
      expect(script).not.toMatch(/TOKEN|PASSWORD|docker\.sock|broker\/private/);
      return { outPath: invocationId };
    },
    readQueryOutput: (outPath: string) => {
      const output = outputs.get(outPath);
      return output !== undefined && Buffer.byteLength(output) <= 8192 ? output : undefined;
    },
    destroyInvocationWorkspace: (_workDir: string, invocationId: string) => {
      destroyed.push(invocationId);
      outputs.delete(invocationId);
    },
  };
  const runner = {
    runQueryContainer: async (params: Record<string, unknown>) => {
      launches.push(params);
      now += options.processingMs ?? 0;
      outputs.set(String(params.invocationId), options.output ?? 'true');
      return {
        exitCode: options.runnerResult?.exitCode ?? 0,
        timedOut: options.runnerResult?.timedOut ?? false,
        stdout: '',
        stderr: '',
      };
    },
  };
  const broker = createBroker({
    config,
    seedMap: new Map([
      ['octo/repo', { seedId: 'a'.repeat(32), sensitivity: options.sensitivity ?? 'internal' }],
    ]),
    runId: 'abcd1234',
    audit: { invocation() {}, failure() {}, lifecycle() {} },
    telemetry: { emit: (event: Record<string, string>) => telemetry.push(event) },
    workspace,
    runner,
    clock: {
      nowMs: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  });
  return { broker, destroyed, launches, sleeps, telemetry };
}

describe('bounded-query runtime conformance matrix', () => {
  it('contains every independent primary/query combination exactly once', () => {
    expect(combinations).toHaveLength(9);
    expect(new Set(combinations.map(({ primaryBackend, queryBackend }) =>
      `${primaryBackend}/${queryBackend}`)).size).toBe(9);
    expect(executableCombinations).toHaveLength(6);
    expect(blockedCombinations).toHaveLength(3);
  });

  it.each(blockedCombinations)(
    '$primaryBackend primary + $queryBackend query fails closed at query preflight',
    ({ primaryBackend, queryBackend }) => {
      const result = evaluateBoundedQueryRuntimeCombination(
        primaryBackend,
        queryBackend,
        deterministicCapabilities,
      );
      expect(result).toEqual({
        primaryBackend,
        queryBackend,
        supported: false,
        capabilityState: 'blocked',
        blockedAt: 'query-preflight',
        category: 'query-security-block',
      });
    },
  );

  it.each([
    ['gvisor', 'docker', 'primary-preflight', 'primary-runtime-unavailable'],
    ['sbx', 'docker', 'primary-preflight', 'primary-runtime-unavailable'],
    ['docker', 'gvisor', 'query-preflight', 'query-runtime-unavailable'],
  ] as const)(
    'reports precise unavailable capability state for %s/%s',
    (primaryBackend, queryBackend, blockedAt, category) => {
      const capabilities: BoundedQueryRuntimeCapabilities = {
        primary: { docker: 'supported', gvisor: 'unavailable', sbx: 'unavailable' },
        query: { docker: 'supported', gvisor: 'unavailable', sbx: 'blocked' },
      };
      expect(evaluateBoundedQueryRuntimeCombination(primaryBackend, queryBackend, capabilities))
        .toMatchObject({ supported: false, capabilityState: 'unavailable', blockedAt, category });
    },
  );

  it.each(executableCombinations)(
    '$primaryBackend primary + $queryBackend query satisfies the common behavioral contract',
    async ({ primaryBackend, queryBackend }) => {
      if (queryBackend === 'sbx') throw new Error('blocked sbx query combination entered executable suite');

      const successful = createHarness(primaryBackend, queryBackend, { processingMs: 50 });
      expect(await invoke(successful.broker, {
        privateRepo: 'octo/repo',
        schema: BOOLEAN_SCHEMA,
        script: 'finite query',
      })).toBe(CANONICAL_OK);
      expect(successful.launches).toHaveLength(1);
      expect(successful.destroyed).toHaveLength(1);
      expect(successful.sleeps).toEqual([50]);
      expect(successful.telemetry).toContainEqual({
        primaryBackend,
        queryBackend,
        lifecycleClass: 'query',
        capabilityState: 'supported',
        category: 'success',
      });
      expect(successful.launches[0]).not.toHaveProperty('repo');
      expect(JSON.stringify(successful.launches[0])).not.toMatch(/TOKEN|PASSWORD|docker\.sock/);

      const publicRepo = createHarness(primaryBackend, queryBackend, {
        sensitivity: 'public',
        maxInvocations: 2,
      });
      expect(await invoke(publicRepo.broker, {
        privateRepo: 'octo/repo',
        schema: BOOLEAN_SCHEMA,
        script: 'public query',
      })).toBe(CANONICAL_OK);
      expect(await invoke(publicRepo.broker, {
        privateRepo: 'octo/repo',
        schema: BOOLEAN_SCHEMA,
        script: 'second public query',
      })).toBe(CANONICAL_OK);
      expect(new Set(publicRepo.launches.map((launch) => launch.invocationId)).size).toBe(2);
      expect(publicRepo.destroyed).toHaveLength(2);

      const wrongRepo = createHarness(primaryBackend, queryBackend);
      expect(await invoke(wrongRepo.broker, {
        privateRepo: 'octo/not-configured',
        schema: BOOLEAN_SCHEMA,
        script: 'must not launch',
      })).toBe(CANONICAL_ERROR);
      expect(wrongRepo.launches).toHaveLength(0);

      const exhausted = createHarness(primaryBackend, queryBackend, { sensitivity: 'confidential' });
      const expensiveSchema = { type: 'integer', minimum: 0, maximum: 255 };
      expect(await invoke(exhausted.broker, {
        privateRepo: 'octo/repo',
        schema: expensiveSchema,
        script: 'must not launch',
      })).toBe(CANONICAL_ERROR);
      expect(exhausted.launches).toHaveLength(0);

      const capped = createHarness(primaryBackend, queryBackend, { maxInvocations: 1 });
      const request = { privateRepo: 'octo/repo', schema: BOOLEAN_SCHEMA, script: 'cap query' };
      expect(await invoke(capped.broker, request)).toBe(CANONICAL_OK);
      expect(await invoke(capped.broker, request)).toBe(CANONICAL_ERROR);
      expect(capped.launches).toHaveLength(1);

      for (const failure of [
        { output: '{malformed', runnerResult: undefined },
        { output: 'x'.repeat(8193), runnerResult: undefined },
        { output: 'true', runnerResult: { exitCode: 137, timedOut: true } },
        { output: 'true', runnerResult: { exitCode: 137, timedOut: false } }, // OOM
        { output: 'true', runnerResult: { exitCode: 152, timedOut: false } }, // file-size
        { output: 'true', runnerResult: { exitCode: 1, timedOut: false } }, // PID/disk
      ]) {
        const failed = createHarness(primaryBackend, queryBackend, failure);
        // eslint-disable-next-line no-await-in-loop
        expect(await invoke(failed.broker, request)).toBe(CANONICAL_ERROR);
        expect(failed.destroyed).toHaveLength(1);
      }
    },
  );

  it.each(executableCombinations)(
    '$primaryBackend primary + $queryBackend query derives a fresh no-network sandbox',
    async ({ primaryBackend: _primaryBackend, queryBackend }) => {
      if (queryBackend === 'sbx') throw new Error('blocked sbx query combination entered executable suite');
      const dockerCalls: string[][] = [];
      const docker = {
        runDocker: async (args: readonly string[]) => {
          dockerCalls.push([...args]);
          if (args[0] === 'info') {
            return { exitCode: 0, timedOut: false, stdout: 'runc\nrunsc\n', stderr: '' };
          }
          return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
        },
      };
      const runner = createQueryRunner({
        queryBackend,
        hostWorkDir: '/daemon/private/work',
        queryMountDir: '/query',
        queryScriptPath: '/awf/query-script.py',
        querySeccompPath: '/opt/awf/query-seccomp.json',
        queryImage: 'ghcr.io/example/bounded-query@sha256:abc',
        memoryLimit: '256m',
        timeoutSeconds: 30,
        queryUid: 65534,
        queryGid: 65534,
      }, { docker });
      await runner.assertAvailable();
      const first = runner.spec('abcd1234', '1'.repeat(16));
      const second = runner.spec('abcd1234', '2'.repeat(16));
      expect(first.containerName).not.toBe(second.containerName);
      expect(first.launchArgs).toEqual(expect.arrayContaining([
        '--network', 'none',
        '--read-only',
        '--cap-drop', 'ALL',
        '--pids-limit', '128',
      ]));
      expect(first.launchArgs.join(' ')).not.toMatch(/docker\.sock|broker\.sock|seed-map|GH_TOKEN/);
      expect(first.launchArgs.filter((arg: string) => arg === '-v')).toHaveLength(3);
      if (queryBackend === 'gvisor') expect(first.launchArgs).toEqual(expect.arrayContaining(['--runtime', 'runsc']));
      if (queryBackend === 'docker') expect(first.launchArgs).not.toContain('--runtime');
      await runner.reconcileRun('abcd1234');
      expect(dockerCalls).toContainEqual([
        'ps',
        '-aq',
        '--filter',
        'label=awf.bounded-query.run=abcd1234',
      ]);
    },
  );
});

describe('bounded-query runtime telemetry', () => {
  it('serializes only the five approved fields', () => {
    const serialized = serializeBoundedQueryRuntimeTelemetry({
      primaryBackend: resolveBoundedQueryPrimaryBackend('runsc'),
      queryBackend: 'docker',
      lifecycleClass: 'preflight',
      capabilityState: 'supported',
      category: 'ready',
    });
    expect(JSON.parse(serialized)).toEqual({
      primaryBackend: 'gvisor',
      queryBackend: 'docker',
      lifecycleClass: 'preflight',
      capabilityState: 'supported',
      category: 'ready',
    });
  });

  it('persists exact-field records without content, paths, outputs, or credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runtime-telemetry-'));
    try {
      const telemetry = createRuntimeTelemetry(root);
      telemetry.emit({
        primaryBackend: 'sbx',
        queryBackend: 'docker',
        lifecycleClass: 'query',
        capabilityState: 'supported',
        category: 'timeout',
        repo: 'must-be-ignored',
        script: 'must-be-ignored',
        output: 'must-be-ignored',
        path: '/must-be-ignored',
        token: 'must-be-ignored',
        capability: 'must-be-ignored',
      });
      const record = JSON.parse(fs.readFileSync(path.join(root, 'runtime-telemetry.jsonl'), 'utf8'));
      expect(Object.keys(record)).toEqual([
        'primaryBackend',
        'queryBackend',
        'lifecycleClass',
        'capabilityState',
        'category',
      ]);
      expect(JSON.stringify(record)).not.toContain('must-be-ignored');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
