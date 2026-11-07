import {
  PUBLIC_ENCLAVE_OPERATION_STAGES, PUBLIC_ENCLAVE_ERROR_CATEGORIES, PUBLIC_ENCLAVE_ENTRYPOINT_OPERATIONS,
} from './public-debug-events';
import type { PublicEnclaveArtifactEnvelope } from './public-debug-artifacts';

/** Shared assertions exercised by the real host adapter implementations, not only their writer. */
export function expectPublicEnclaveAdapterConformance(
  envelope: PublicEnclaveArtifactEnvelope, runtime: 'docker' | 'cloud-hypervisor',
): void {
  expect(envelope).toMatchObject({
    version: 1, runtime, workloadStopped: true,
    runId: expect.stringMatching(/^[a-f0-9]{32}$/),
    invocationId: expect.stringMatching(/^[a-f0-9]{32}$/),
    entryId: expect.any(String), executorKind: expect.stringMatching(/^(agent|script)$/),
  });
  expect(envelope.stages?.length).toBeLessThanOrEqual(64);
  expect([...new Set(envelope.stages?.map(event => event.stage))].sort())
    .toEqual([...PUBLIC_ENCLAVE_OPERATION_STAGES].sort());
  for (const event of envelope.stages ?? []) {
    expect(PUBLIC_ENCLAVE_OPERATION_STAGES).toContain(event.stage);
    expect(['started', 'succeeded', 'failed', 'unavailable', 'not-applicable']).toContain(event.status);
    if (event.category) expect(PUBLIC_ENCLAVE_ERROR_CATEGORIES).toContain(event.category);
    if (event.operation) {
      expect(event.stage).toBe('entrypoint-initialization');
      expect(event.status).toBe('failed');
      expect(PUBLIC_ENCLAVE_ENTRYPOINT_OPERATIONS).toContain(event.operation);
    }
    expect(Object.keys(event).every(key => ['stage', 'status', 'category', 'errno', 'operation'].includes(key))).toBe(true);
  }
  if (envelope.primaryFailure) expect(envelope.primaryFailure).not.toHaveProperty('message');
  if (envelope.cleanupFailure) expect(envelope.cleanupFailure).not.toHaveProperty('message');
  if (envelope.failure === 'workload-exit') expect(envelope.stage).toBe('execution');
}
