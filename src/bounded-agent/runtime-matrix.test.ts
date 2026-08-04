import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOUNDED_AGENT_RUNTIME_BACKENDS,
  evaluateBoundedAgentRuntimeCombination,
  evaluateBoundedAgentRuntimeMatrix,
  resolveBoundedAgentPrimaryBackend,
  serializeBoundedAgentRuntimeTelemetry,
  type BoundedAgentPrimaryBackend,
  type BoundedAgentRuntimeCapabilities,
} from './runtime-matrix';
import type { BoundedAgentRuntime } from '../types';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { createBroker } = require(path.join(brokerDir, 'broker.js'));
const { createRuntimeTelemetry } = require(path.join(brokerDir, 'runtime-telemetry.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const CANONICAL_ERROR = '{"status":"error"}';
const PRIMARY_BACKENDS = BOUNDED_AGENT_RUNTIME_BACKENDS;
const BOUNDED_AGENT_BACKENDS = BOUNDED_AGENT_RUNTIME_BACKENDS;

/**
 * The real-world capability state: every primary backend is available (once
 * its own runtime preflight passes), docker and gvisor enclaves are
 * available once their preflight passes, and the sbx enclave backend is
 * always `blocked` — never `unavailable` — because the CLI/daemon exists but
 * cannot prove the mandatory isolation controls (see ./sbx-capability.ts).
 */
const deterministicCapabilities: BoundedAgentRuntimeCapabilities = {
  primary: {
    docker: 'supported',
    gvisor: 'supported',
    sbx: 'supported',
  },
  enclave: {
    docker: 'supported',
    gvisor: 'supported',
    sbx: 'blocked',
  },
};

const combinations = PRIMARY_BACKENDS.flatMap((primaryBackend) =>
  BOUNDED_AGENT_BACKENDS.map((boundedAgentBackend) => ({ primaryBackend, boundedAgentBackend })));
const executableCombinations = combinations.filter(({ primaryBackend, boundedAgentBackend }) =>
  evaluateBoundedAgentRuntimeCombination(primaryBackend, boundedAgentBackend, deterministicCapabilities).supported);
const blockedCombinations = combinations.filter(({ primaryBackend, boundedAgentBackend }) =>
  !evaluateBoundedAgentRuntimeCombination(primaryBackend, boundedAgentBackend, deterministicCapabilities).supported);

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
  primaryBackend: BoundedAgentPrimaryBackend,
  boundedAgentBackend: 'docker' | 'gvisor',
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
    backend: boundedAgentBackend,
    workDir: '/broker/private/work',
    timeoutSeconds: 30,
    maxInvocations: options.maxInvocations ?? 8,
    maxTaskBytes: 4096,
  };
  const workspace = {
    createInvocationWorkspace: ({
      invocationId,
      task,
    }: {
      invocationId: string;
      task: string;
    }) => {
      expect(task).not.toMatch(/TOKEN|PASSWORD|docker\.sock|broker\/private/);
      return { outPath: invocationId, sessionLogPath: `${invocationId}.jsonl` };
    },
    readEnclaveOutput: (outPath: string) => {
      const output = outputs.get(outPath);
      return output !== undefined && Buffer.byteLength(output) <= 8192 ? output : undefined;
    },
    preserveInvocationSession: () => true,
    destroyInvocationWorkspace: (_workDir: string, invocationId: string) => {
      destroyed.push(invocationId);
      outputs.delete(invocationId);
    },
  };
  const runner = {
    runEnclaveContainer: async (params: Record<string, unknown>) => {
      launches.push(params);
      now += options.processingMs ?? 0;
      outputs.set(String(params.invocationId), options.output ?? 'true');
      return {
        exitCode: options.runnerResult?.exitCode ?? 0,
        timedOut: options.runnerResult?.timedOut ?? false,
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

describe('bounded-agent runtime conformance matrix', () => {
  it('contains every independent primary/boundedAgent combination exactly once', () => {
    expect(combinations).toHaveLength(9);
    expect(new Set(combinations.map(({ primaryBackend, boundedAgentBackend }) =>
      `${primaryBackend}/${boundedAgentBackend}`)).size).toBe(9);
    expect(executableCombinations).toHaveLength(6);
    expect(blockedCombinations).toHaveLength(3);
  });

  it('supports every primary backend paired with docker/gvisor bounded agents, and blocks sbx bounded agents everywhere', () => {
    const readyPairs = new Set(executableCombinations.map(
      ({ primaryBackend, boundedAgentBackend }) => `${primaryBackend}/${boundedAgentBackend}`,
    ));
    for (const primaryBackend of PRIMARY_BACKENDS) {
      expect(readyPairs.has(`${primaryBackend}/docker`)).toBe(true);
      expect(readyPairs.has(`${primaryBackend}/gvisor`)).toBe(true);
      expect(readyPairs.has(`${primaryBackend}/sbx`)).toBe(false);
    }
  });

  it.each(blockedCombinations)(
    '$primaryBackend primary + $boundedAgentBackend bounded agent fails closed at enclave preflight',
    ({ primaryBackend, boundedAgentBackend }) => {
      const result = evaluateBoundedAgentRuntimeCombination(
        primaryBackend,
        boundedAgentBackend,
        deterministicCapabilities,
      );
      expect(result).toEqual({
        primaryBackend,
        boundedAgentBackend,
        supported: false,
        capabilityState: 'blocked',
        blockedAt: 'enclave-preflight',
        category: 'enclave-security-block',
      });
    },
  );

  it.each([
    ['gvisor', 'docker', 'primary-preflight', 'primary-runtime-unavailable'],
    ['sbx', 'docker', 'primary-preflight', 'primary-runtime-unavailable'],
    ['docker', 'gvisor', 'enclave-preflight', 'enclave-runtime-unavailable'],
  ] as const)(
    'reports precise unavailable capability state for %s/%s',
    (primaryBackend, boundedAgentBackend, blockedAt, category) => {
      const capabilities: BoundedAgentRuntimeCapabilities = {
        primary: { docker: 'supported', gvisor: 'unavailable', sbx: 'unavailable' },
        enclave: { docker: 'supported', gvisor: 'unavailable', sbx: 'blocked' },
      };
      expect(evaluateBoundedAgentRuntimeCombination(primaryBackend, boundedAgentBackend, capabilities))
        .toMatchObject({ supported: false, capabilityState: 'unavailable', blockedAt, category });
    },
  );

  it('evaluates the full matrix via evaluateBoundedAgentRuntimeMatrix in the same order', () => {
    const matrix = evaluateBoundedAgentRuntimeMatrix(deterministicCapabilities);
    expect(matrix).toHaveLength(9);
    expect(matrix).toEqual(combinations.map(({ primaryBackend, boundedAgentBackend }) =>
      evaluateBoundedAgentRuntimeCombination(primaryBackend, boundedAgentBackend, deterministicCapabilities)));
  });

  it.each(executableCombinations)(
    '$primaryBackend primary + $boundedAgentBackend bounded agent satisfies the common behavioral contract',
    async ({ primaryBackend, boundedAgentBackend }) => {
      if (boundedAgentBackend === 'sbx') throw new Error('blocked sbx bounded-agent combination entered executable suite');

      const successful = createHarness(primaryBackend, boundedAgentBackend, { processingMs: 50 });
      expect(await invoke(successful.broker, {
        privateRepo: 'octo/repo',
        schema: { type: 'boolean' },
        task: 'is this finite?',
      })).toBe('{"status":"ok","result":true}');
      expect(successful.launches).toHaveLength(1);
      expect(successful.destroyed).toHaveLength(1);
      expect(successful.sleeps).toEqual([50]);
      expect(successful.telemetry).toContainEqual({
        primaryBackend,
        boundedAgentBackend,
        lifecycleClass: 'invocation',
        capabilityState: 'supported',
        category: 'success',
      });
      expect(successful.launches[0]).not.toHaveProperty('repo');
      expect(JSON.stringify(successful.launches[0])).not.toMatch(/TOKEN|PASSWORD|docker\.sock/);

      const wrongRepo = createHarness(primaryBackend, boundedAgentBackend);
      expect(await invoke(wrongRepo.broker, {
        privateRepo: 'octo/not-configured',
        schema: { type: 'boolean' },
        task: 'must not launch',
      })).toBe(CANONICAL_ERROR);
      expect(wrongRepo.launches).toHaveLength(0);

      const capped = createHarness(primaryBackend, boundedAgentBackend, { maxInvocations: 1 });
      const request = { privateRepo: 'octo/repo', schema: { type: 'boolean' }, task: 'cap invocation' };
      expect(await invoke(capped.broker, request)).toBe('{"status":"ok","result":true}');
      expect(await invoke(capped.broker, request)).toBe(CANONICAL_ERROR);
      expect(capped.launches).toHaveLength(1);

      for (const failure of [
        { output: '{malformed', runnerResult: undefined },
        { output: 'true', runnerResult: { exitCode: 137, timedOut: true } },
        { output: 'true', runnerResult: { exitCode: 1, timedOut: false } },
      ]) {
        const failed = createHarness(primaryBackend, boundedAgentBackend, failure);
        // eslint-disable-next-line no-await-in-loop
        expect(await invoke(failed.broker, request)).toBe(CANONICAL_ERROR);
        expect(failed.destroyed).toHaveLength(1);
      }
    },
  );
});

describe('resolveBoundedAgentPrimaryBackend', () => {
  it.each([
    [undefined, 'docker'],
    ['docker', 'docker'],
    ['gvisor', 'gvisor'],
    ['runsc', 'gvisor'],
    ['sbx', 'sbx'],
    ['kata', 'docker'],
  ] as const)('maps containerRuntime %s to primary backend %s', (containerRuntime, expected) => {
    expect(resolveBoundedAgentPrimaryBackend(containerRuntime)).toBe(expected);
  });
});

describe('bounded-agent runtime telemetry', () => {
  it('serializes only the five approved fields', () => {
    const serialized = serializeBoundedAgentRuntimeTelemetry({
      primaryBackend: resolveBoundedAgentPrimaryBackend('runsc'),
      boundedAgentBackend: 'docker' as BoundedAgentRuntime,
      lifecycleClass: 'preflight',
      capabilityState: 'supported',
      category: 'ready',
    });
    expect(JSON.parse(serialized)).toEqual({
      primaryBackend: 'gvisor',
      boundedAgentBackend: 'docker',
      lifecycleClass: 'preflight',
      capabilityState: 'supported',
      category: 'ready',
    });
  });

  it('persists exact-field records without content, paths, outputs, or credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-runtime-telemetry-'));
    try {
      const telemetry = createRuntimeTelemetry(root);
      telemetry.emit({
        primaryBackend: 'sbx',
        boundedAgentBackend: 'docker',
        lifecycleClass: 'invocation',
        capabilityState: 'supported',
        category: 'timeout',
        repo: 'must-be-ignored',
        task: 'must-be-ignored',
        output: 'must-be-ignored',
        path: '/must-be-ignored',
        token: 'must-be-ignored',
        capability: 'must-be-ignored',
      });
      const record = JSON.parse(fs.readFileSync(path.join(root, 'runtime-telemetry.jsonl'), 'utf8'));
      expect(Object.keys(record)).toEqual([
        'primaryBackend',
        'boundedAgentBackend',
        'lifecycleClass',
        'capabilityState',
        'category',
      ]);
      expect(JSON.stringify(record)).not.toContain('must-be-ignored');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an enclave-runtime value outside the fixed enum', () => {
    const brokerRuntimeTelemetry = createRuntimeTelemetry(
      fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-runtime-telemetry-invalid-')),
    );
    expect(() => brokerRuntimeTelemetry.emit({
      primaryBackend: 'docker',
      boundedAgentBackend: 'firecracker',
      lifecycleClass: 'invocation',
      capabilityState: 'supported',
      category: 'success',
    })).toThrow(/Invalid bounded-agent telemetry/);
  });
});
