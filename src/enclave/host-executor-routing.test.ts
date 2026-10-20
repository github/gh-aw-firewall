import { createHash } from 'crypto';
import { validateSchema } from '../bounded-execution/finite-schema';

/* eslint-disable @typescript-eslint/no-require-imports */
const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
const { createHostExecutorRunner, usesHostExecutor } = require('../../containers/enclave/mcp-server/host-executor-runner');
const { loadConfig, loadAgentConfig } = require('../../containers/enclave/mcp-server/config');
const { createExecutorHandler } = require('../../containers/enclave/script-executor/executor-handler');
const { createAgentRequestValidator } = require('../../containers/enclave/mcp-server/agent-executor');
const { createEnclaveInformationBudgetLedger } = require('../../containers/bounded-execution/sensitivity-ledger');
const { informationChargeForSchema } = require('../../containers/bounded-execution/finite-disclosure');
/* eslint-enable @typescript-eslint/no-require-imports */

jest.mock('../../containers/enclave/mcp-server/host-executor-client');

describe('trusted host transport routing', () => {
  beforeEach(() => jest.resetAllMocks());

  it.each(['docker', 'nvx', 'cloud-hypervisor'])(
    'uses the same protocol for a trusted %s adapter without sending launch controls', async (backend) => {
      const digest = createHash('sha256').update(JSON.stringify(['success', 'true'])).digest('hex');
      const client = {
        status: jest.fn().mockResolvedValue({ ok: false, error: 'unknown-invocation' }),
        invoke: jest.fn().mockResolvedValue({
          ok: true, state: 'terminal', outcome: 'success', result: 'true',
          resultDigest: digest, cancelGeneration: 0,
        }),
        settle: jest.fn().mockResolvedValue({
          ok: true, state: 'settled', outcome: 'success', resultDigest: digest, cancelGeneration: 0,
        }),
      };
      createHostExecutorClient.mockReturnValue(client);
      const config = {
        executorBackend: backend, executorTransport: 'host', entryId: 'script',
        runId: 'a'.repeat(32), hostExecutorSocketPath: '/private/executor.sock',
        hostExecutorCapabilityPath: '/private/capability',
      };
      expect(usesHostExecutor(config)).toBe(true);
      const runner = createHostExecutorRunner(config, { nowMs: () => 0 });
      await runner.assertAvailable();
      const parsed = validateSchema({ type: 'boolean' });
      if (!parsed.valid) throw new Error('Invalid test schema');
      await expect(runner.runInvocation({
        invocationId: 'b'.repeat(32), seedId: 'c'.repeat(32), payload: 'print(True)',
        schema: parsed.schema, admissionId: 'd'.repeat(32), executorKind: 'script', deadlineMs: 1000,
      })).resolves.toEqual({
        status: 'completed', timedOut: false, exitCode: 0, rawResult: 'true',
      });
      expect(Object.keys(client.invoke.mock.calls[0][0]).sort()).toEqual([
        'admissionId', 'entryId', 'executorKind', 'invocationId', 'payload', 'schema', 'schemaHash', 'seedId',
      ]);
      expect(client.settle).toHaveBeenCalledWith({
        entryId: 'script', invocationId: 'b'.repeat(32), resultDigest: digest,
      });
    },
  );

  it('requires host routing for Docker while preserving local gVisor routing', () => {
    expect(usesHostExecutor({ executorBackend: 'docker' })).toBe(true);
    expect(usesHostExecutor({ executorBackend: 'gvisor' })).toBe(false);
    expect(usesHostExecutor({ executorBackend: 'cloud-hypervisor' })).toBe(true);
    expect(() => createHostExecutorRunner({ executorBackend: 'nvx', entryId: 'script' }))
      .toThrow('Invalid trusted host executor configuration');
  });

  it('does not enable NVX through broker environment selection', () => {
    const environment = process.env;
    process.env = {
      ...environment, AWF_ENCLAVE_BACKEND: 'nvx', AWF_ENCLAVE_AGENT_BACKEND: 'nvx',
    };
    try {
      expect(() => loadConfig()).toThrow(/AWF_ENCLAVE_BACKEND/);
      expect(() => loadAgentConfig({})).toThrow(/AWF_ENCLAVE_AGENT_BACKEND/);
    } finally {
      process.env = environment;
    }
  });

  it.each(['script', 'agent'])('loads Docker %s without any broker launch controls', (kind) => {
    const saved = process.env;
    process.env = {
      AWF_ENCLAVE_PRIMARY_BACKEND: 'docker', AWF_ENCLAVE_RUN_ID: 'a'.repeat(32),
      AWF_ENCLAVE_BACKEND: 'docker', AWF_ENCLAVE_ENTRY_ID: 'script',
      AWF_ENCLAVE_AGENT_BACKEND: 'docker', AWF_ENCLAVE_AGENT_ENTRY_ID: 'agent',
      AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true', AWF_ENCLAVE_AGENT_DYNAMIC_SENSITIVITY: 'confidential',
    };
    try {
      const config = kind === 'script'
        ? loadConfig({ readFileSync: () => 'b'.repeat(64) })
        : loadAgentConfig({ runId: 'a'.repeat(32), primaryBackend: 'docker' });
      expect(config).toMatchObject({
        entryId: kind, executorBackend: 'docker', executorTransport: 'host',
        hostExecutorSocketPath: '/run/awf-enclave-host-executor/executor.sock',
      });
      for (const field of ['queryImage', 'enclaveImage', 'hostWorkDir', 'hostSeedsDir',
        'modelBudgetSecret', 'dynamicChannelDir', 'githubAgentId']) {
        expect(config).not.toHaveProperty(field);
      }
      if (kind === 'agent') {
        expect(config).toMatchObject({ dynamicEnabled: true, dynamicSensitivity: 'confidential' });
      }
    } finally {
      process.env = saved;
    }
  });

  it('debits dynamic disclosure before host admission and settles v2 without any broker delegation', async () => {
    const digest = createHash('sha256').update(JSON.stringify(['success', 'true'])).digest('hex');
    const client = {
      invoke: jest.fn().mockResolvedValue({
        ok: true, state: 'terminal', outcome: 'success', result: 'true',
        resultDigest: digest, cancelGeneration: 0,
      }),
      settle: jest.fn().mockResolvedValue({
        ok: true, state: 'settled', outcome: 'success', resultDigest: digest, cancelGeneration: 0,
      }),
    };
    createHostExecutorClient.mockReturnValue(client);
    const config = {
      executorBackend: 'docker', entryId: 'agent', runId: 'a'.repeat(32),
      dynamicEnabled: true, dynamicSensitivity: 'internal',
      timeoutSeconds: 30, maxInvocations: 4, maxOutputBytes: 8192,
    };
    const ledger = createEnclaveInformationBudgetLedger(new Map());
    let now = 0;
    const workspace = { createInvocationWorkspace: jest.fn(), destroyInvocationWorkspace: jest.fn() };
    const handler = createExecutorHandler({
      config, seedMap: new Map(), runId: config.runId,
      runner: createHostExecutorRunner(config, { nowMs: () => now }),
      ledger, workspace, audit: { failure: jest.fn(), invocation: jest.fn() },
      clock: { nowMs: () => now, sleep: async (ms: number) => { now += ms; } },
      responseJitterSource: () => 0,
      validateRequest: createAgentRequestValidator(4096, { dynamicEnabled: true }),
      payloadKey: 'prompt', executorKind: 'agent',
    });
    const debit = jest.spyOn(ledger, 'tryDebit');
    const respond = jest.fn();
    const request = { privateRepo: 'Octo/Private', prompt: 'check', schema: { type: 'boolean' } };
    await handler.handle(request, respond);
    await handler.handle(request, respond);
    expect(respond.mock.calls).toEqual([
      ['{"status":"ok","result":true}'], ['{"status":"ok","result":true}'],
    ]);
    const parsed = validateSchema({ type: 'boolean' });
    if (!parsed.valid) throw new Error('Invalid fixture schema');
    const charge = informationChargeForSchema(parsed.schema);
    expect(debit).toHaveBeenNthCalledWith(1, 'octo/private', charge, 'agent');
    expect(debit.mock.invocationCallOrder[0]).toBeLessThan(client.invoke.mock.invocationCallOrder[0]);
    expect(ledger.remainingBits('octo/private')).toBe(64 - 2 * charge);
    expect(client.settle).toHaveBeenCalledTimes(2);
    for (const [invoke] of client.invoke.mock.calls) {
      expect(invoke.selector).toBe('octo/private');
      expect(invoke.admissionId).toBe(invoke.invocationId);
      expect(Object.keys(invoke).sort()).toEqual([
        'admissionId', 'entryId', 'executorKind', 'invocationId', 'payload', 'schema', 'schemaHash', 'selector',
      ]);
    }
    expect(workspace.createInvocationWorkspace).not.toHaveBeenCalled();
    expect(workspace.destroyInvocationWorkspace).not.toHaveBeenCalled();
  });

  it.each([0, 1])('never refunds a Docker dynamic reservation after host exit %s', async (exitCode) => {
    const ledger = createEnclaveInformationBudgetLedger(new Map());
    const runner = {
      hostOwned: true,
      runInvocation: jest.fn().mockResolvedValue({
        status: 'completed', timedOut: false, exitCode, rawResult: exitCode === 0 ? 'true' : undefined,
      }),
    };
    const handler = createExecutorHandler({
      config: {
        executorBackend: 'docker', dynamicEnabled: true, dynamicSensitivity: 'confidential',
        timeoutSeconds: 30, maxInvocations: 4, maxOutputBytes: 8192,
      },
      seedMap: new Map(), ledger, runner,
      audit: { failure: jest.fn(), invocation: jest.fn() },
      clock: { nowMs: () => 0, sleep: async () => undefined },
      responseJitterSource: () => 0,
      validateRequest: createAgentRequestValidator(4096, { dynamicEnabled: true }),
      payloadKey: 'prompt', executorKind: 'agent',
    });
    const respond = jest.fn();
    const request = { privateRepo: 'octo/private', prompt: 'check', schema: { type: 'boolean' } };
    await handler.handle(request, respond);
    const remaining = ledger.remainingBits('octo/private');
    expect(remaining).toBeLessThan(8);
    await handler.handle({ ...request, privateRepo: 'Octo/Private' }, respond);
    expect(runner.runInvocation).toHaveBeenCalledTimes(1);
    expect(ledger.remainingBits('octo/private')).toBe(remaining);
    expect(respond).toHaveBeenLastCalledWith('{"status":"error"}');
  });

  it.each(['script', 'agent'])(
    'characterizes the %s invocation counter as handler-local, not restart-durable',
    async (executorKind) => {
      const seedMap = new Map([['octo/private', { seedId: 'b'.repeat(32), sensitivity: 'public' }]]);
      const ledger = createEnclaveInformationBudgetLedger(seedMap);
      const runner = {
        hostOwned: true,
        runInvocation: jest.fn().mockResolvedValue({
          status: 'completed', timedOut: false, exitCode: 0, rawResult: 'true',
        }),
      };
      const payloadKey = executorKind === 'agent' ? 'prompt' : 'script';
      const params = {
        config: {
          executorBackend: 'docker', timeoutSeconds: 30, maxInvocations: 1, maxOutputBytes: 8192,
        },
        runId: 'a'.repeat(32), seedMap, ledger, runner,
        lane: { tail: Promise.resolve() },
        audit: { failure: jest.fn(), invocation: jest.fn() },
        clock: { nowMs: () => 0, sleep: async () => undefined },
        responseJitterSource: () => 0,
        executorKind, payloadKey,
        ...(executorKind === 'agent' && { validateRequest: createAgentRequestValidator(4096) }),
      };
      const request = { privateRepo: 'octo/private', schema: { type: 'boolean' }, [payloadKey]: 'check' };
      const first = createExecutorHandler(params);
      const respond = jest.fn();
      expect(first.invocationsUsed).toBe(0);
      await first.handle(request, respond);
      await first.handle(request, respond);
      expect(first.invocationsUsed).toBe(1);
      expect(runner.runInvocation).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenLastCalledWith('{"status":"error"}');
      first.close();
      await first.drain();

      const replacement = createExecutorHandler(params);
      expect(replacement.invocationsUsed).toBe(0);
      await replacement.handle(request, respond);
      expect(replacement.invocationsUsed).toBe(1);
      expect(runner.runInvocation).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenLastCalledWith('{"status":"ok","result":true}');
      replacement.close();
      await replacement.drain();
    },
  );
});
