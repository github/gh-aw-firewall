import { createHash } from 'crypto';
import { validateSchema } from '../bounded-execution/finite-schema';

/* eslint-disable @typescript-eslint/no-require-imports */
const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
const { createHostExecutorRunner, usesHostExecutor } = require('../../containers/enclave/mcp-server/host-executor-runner');
const { loadConfig, loadAgentConfig } = require('../../containers/enclave/mcp-server/config');
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

  it('preserves local Docker routing unless trusted configuration selects host transport', () => {
    expect(usesHostExecutor({ executorBackend: 'docker' })).toBe(false);
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
});
