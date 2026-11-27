import {
  HostExecutorInvocationRegistry,
  HOST_EXECUTOR_MAX_REQUEST_IDS,
  HOST_EXECUTOR_DRAIN_REQUEST_IDS,
  HOST_EXECUTOR_MAX_INVOCATIONS,
  type InvocationRecord,
} from './host-executor-invocation-registry';
import { RequestRejection } from './host-executor-runtime';
import type { HostExecutorInvocationPlan } from './host-executor-server';

function invocation(invocationId = 'invocation', admissionId = 'admission', entryId = 'script'): InvocationRecord {
  const plan: HostExecutorInvocationPlan = {
    runId: 'run', entryId, invocationId, admissionId, executorKind: 'script',
    timeoutMs: 1_000, requestHash: 'hash', schemaHash: 'schema-hash',
    schema: { type: 'boolean' }, payload: 'print(True)', invocationHostDir: '/private/invocation',
  };
  return { plan, state: 'running', cancelGeneration: 0, controller: new AbortController(), completion: Promise.resolve() };
}

describe('host executor invocation registry', () => {
  let registry: HostExecutorInvocationRegistry;

  beforeEach(() => { registry = new HostExecutorInvocationRegistry(); });

  it('tracks request IDs independently of invocation identities and preserves replay precedence', () => {
    expect(registry.trackRequest({ type: 'invoke', requestId: 'request' })).toBeUndefined();
    expect(registry.trackRequest({ type: 'status', requestId: 'request' })).toBe('replayed');
    registry.closeAdmissions();
    expect(registry.trackRequest({ type: 'cancel', requestId: 'cancel' })).toBeUndefined();
    expect(() => registry.assertCanAdmit('admission', 'invocation')).toThrow(new RequestRejection('closed'));
  });

  it('keeps a bounded drain reserve after reaching the normal request budget', () => {
    for (let i = 0; i < HOST_EXECUTOR_MAX_REQUEST_IDS; i++) {
      if (registry.trackRequest({ type: 'status', requestId: `request-${i}` })) {
        throw new Error('Request budget exhausted early');
      }
    }
    expect(registry.trackRequest({ type: 'invoke', requestId: 'new-invoke' })).toBe('closed');
    expect(() => registry.assertCanAdmit('admission', 'invocation')).toThrow(new RequestRejection('closed'));
    const types = ['cancel', 'status', 'settle'] as const;
    for (let i = 0; i < HOST_EXECUTOR_DRAIN_REQUEST_IDS; i++) {
      if (registry.trackRequest({ type: types[i % types.length], requestId: `drain-${i}` })) {
        throw new Error('Drain reserve exhausted early');
      }
    }
    expect(registry.trackRequest({ type: 'status', requestId: 'overflow' })).toBe('closed');
    expect(registry.trackRequest({ type: 'settle', requestId: 'drain-0' })).toBe('replayed');
  });

  it('keys records by both entry and invocation while reserving identities across entries', () => {
    const record = invocation();
    registry.register(record);
    expect(registry.get('script', 'invocation')).toBe(record);
    expect(registry.get('agent', 'invocation')).toBeUndefined();
    expect([...registry.values()]).toEqual([record]);
    expect(() => registry.assertCanAdmit('other-admission', 'invocation')).toThrow(new RequestRejection('conflict'));
    expect(() => registry.assertCanAdmit('admission', 'other-invocation')).toThrow(new RequestRejection('conflict'));
    expect(() => registry.assertCanAdmit('other-admission', 'other-invocation')).not.toThrow();
    record.state = 'settled';
    expect(() => registry.assertCanAdmit('admission', 'other-invocation')).toThrow(new RequestRejection('conflict'));
    expect(() => registry.assertCanAdmit('other-admission', 'invocation')).toThrow(new RequestRejection('conflict'));
  });

  it('closes admissions at the invocation limit while retaining known records', () => {
    for (let i = 0; i < HOST_EXECUTOR_MAX_INVOCATIONS; i++) {
      registry.assertCanAdmit(`admission-${i}`, `invocation-${i}`);
      registry.register(invocation(`invocation-${i}`, `admission-${i}`));
    }
    expect(() => registry.assertCanAdmit('overflow', 'overflow')).toThrow(new RequestRejection('closed'));
    expect(() => registry.assertCanAdmit('admission-0', 'invocation-0')).toThrow(new RequestRejection('closed'));
    expect(registry.get('script', 'invocation-0')).toBeDefined();
  });

  it('exposes only protocol fields, omitting absent values without dropping empty results', () => {
    const record = invocation();
    expect(registry.view(record)).toEqual({ state: 'running', cancelGeneration: 0 });
    Object.assign(record, { state: 'terminal', outcome: 'success', result: '', resultDigest: 'digest' });
    expect(registry.view(record)).toEqual({
      state: 'terminal', cancelGeneration: 0, outcome: 'success', result: '', resultDigest: 'digest',
    });
  });
});
