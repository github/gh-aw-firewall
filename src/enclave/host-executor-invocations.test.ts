import { finiteSchemaHash } from '../bounded-execution/schema-hash';
import { createHostExecutorInvocations } from './host-executor-invocations';
import { RequestRejection } from './host-executor-runtime';
import { HOST_EXECUTOR_PROTOCOL_VERSION, hostExecutorResultDigest } from './host-executor-protocol';
import type { HostExecutorInvokeRequest, HostExecutorStatusRequest } from './host-executor-protocol';
import type { HostExecutorBackendResult, HostExecutorRunState } from './host-executor-server';

describe('host executor invocation handling boundary', () => {
  const schema = { type: 'boolean' } as const;
  const runState: HostExecutorRunState = {
    runId: 'a'.repeat(32), seedsDir: '/private/seeds', invocationsDir: '/private/invocations',
    entries: [{
      entryId: 'script', executorKind: 'script', timeoutMs: 1_000,
      staticSeedIds: ['b'.repeat(32)], dynamicAgents: false,
    }],
  };
  const request: HostExecutorInvokeRequest = {
    version: HOST_EXECUTOR_PROTOCOL_VERSION, type: 'invoke', requestId: '1'.repeat(32),
    runId: runState.runId, entryId: 'script', invocationId: 'c'.repeat(32),
    admissionId: 'd'.repeat(32), seedId: 'b'.repeat(32), executorKind: 'script',
    payload: 'print(True)', schema, schemaHash: finiteSchemaHash(schema),
  };

  it('journals admission before execution, handles replay, and releases results only after settlement', async () => {
    const events: string[] = [];
    let complete!: (result: HostExecutorBackendResult) => void;
    const execute = jest.fn(() => {
      events.push('execute');
      return new Promise<HostExecutorBackendResult>((resolve) => { complete = resolve; });
    });
    const journal = { record: jest.fn(({ state }: { state: string }) => { events.push(state); }) };
    const invocations = createHostExecutorInvocations({
      runState, backend: { execute }, statusLeaseMs: 15_000, journal, diagnostics: { record: jest.fn() },
    });
    expect(invocations.handle(request)).toMatchObject({ ok: true, state: 'running' });
    expect(events).toEqual(['running']);
    expect(invocations.handle(request)).toMatchObject({ ok: false, error: 'replayed' });
    expect(invocations.handle({ ...request, requestId: '2'.repeat(32) }))
      .toMatchObject({ ok: true, state: 'running' });
    await Promise.resolve();
    expect(events).toEqual(['running', 'execute']);
    expect(execute).toHaveBeenCalledTimes(1);
    invocations.closeAdmissions();
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await invocations.waitForCompletion();
    const status: HostExecutorStatusRequest = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, type: 'status',
      requestId: '3'.repeat(32), runId: request.runId, entryId: request.entryId,
      invocationId: request.invocationId,
    };
    expect(invocations.handle(status)).toMatchObject({ state: 'terminal', result: 'true' });
    const resultDigest = hostExecutorResultDigest('success', 'true');
    expect(invocations.handle({ ...status, requestId: '4'.repeat(32), type: 'settle', resultDigest }))
      .toEqual({
        version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: true, requestId: '4'.repeat(32),
        invocationId: request.invocationId, state: 'settled', cancelGeneration: 0,
        outcome: 'success', resultDigest,
      });
    expect(events).toEqual(['running', 'execute', 'terminal', 'settled']);
    expect(JSON.stringify(journal.record.mock.calls)).not.toContain(request.payload);
    expect(invocations.handle({
      ...request, requestId: '5'.repeat(32), invocationId: 'e'.repeat(32), admissionId: 'f'.repeat(32),
    })).toMatchObject({ ok: false, error: 'closed' });
  });

  it('recognizes the runtime rejection identity and keeps admissions open after a policy denial', async () => {
    const diagnostics = { record: jest.fn() };
    const execute = jest.fn(async (): Promise<HostExecutorBackendResult> => ({ outcome: 'success', result: 'true' }));
    const invocations = createHostExecutorInvocations({
      runState, backend: { execute }, statusLeaseMs: 15_000, journal: { record: jest.fn() }, diagnostics,
    });
    expect(invocations.handle({ ...request, seedId: 'e'.repeat(32) }))
      .toMatchObject({ ok: false, error: 'denied' });
    expect(diagnostics.record).toHaveBeenCalledWith(
      'plan-static-seed', expect.any(RequestRejection), 'denied', request.invocationId,
    );
    expect(invocations.handle({ ...request, requestId: '2'.repeat(32) }))
      .toMatchObject({ ok: true, state: 'running' });
    await invocations.waitForCompletion();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retains a nonterminal tombstone and cancels peers when terminal persistence fails', async () => {
    const completions: Array<(result: HostExecutorBackendResult) => void> = [];
    const signals: AbortSignal[] = [];
    const invocations = createHostExecutorInvocations({
      runState,
      backend: {
        execute: (_plan, signal) => {
          signals.push(signal);
          return new Promise<HostExecutorBackendResult>((resolve) => { completions.push(resolve); });
        },
      },
      statusLeaseMs: 15_000,
      journal: {
        record: ({ state, invocationId }) => {
          if (state === 'terminal' && invocationId === request.invocationId) {
            throw new Error('Persistence failed');
          }
        },
      },
      diagnostics: { record: jest.fn() },
    });
    const peer = {
      ...request, requestId: '2'.repeat(32), invocationId: 'e'.repeat(32), admissionId: 'f'.repeat(32),
    };
    invocations.handle(request);
    invocations.handle(peer);
    await Promise.resolve();
    completions[0]({ outcome: 'success', result: 'true', cleanupComplete: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    const status: HostExecutorStatusRequest = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, type: 'status', requestId: '3'.repeat(32),
      runId: request.runId, entryId: request.entryId, invocationId: request.invocationId,
    };
    expect(invocations.handle(status)).toEqual({
      version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: true, requestId: status.requestId,
      invocationId: request.invocationId, state: 'cancelling', cancelGeneration: 0,
    });
    expect(invocations.handle({
      ...request, requestId: '4'.repeat(32), invocationId: '5'.repeat(32), admissionId: '6'.repeat(32),
    })).toMatchObject({ ok: false, error: 'closed' });
    completions[1]({ outcome: 'success', result: 'true', cleanupComplete: true });
    await invocations.waitForCompletion();
    expect(invocations.handle({ ...status, requestId: '7'.repeat(32), invocationId: peer.invocationId }))
      .toMatchObject({ state: 'terminal', outcome: 'cancelled' });
  });
});
