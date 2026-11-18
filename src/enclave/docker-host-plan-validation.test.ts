import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { DockerHostExecutorEntry } from './docker-host-context';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import {
  isDockerHostInvocationPathValid, isDockerHostPlanIdentityValid, isDockerHostSeedValid, type DockerHostDebugCheck,
} from './docker-host-plan-validation';
import { PublicEnclaveOperationRecorder } from './public-debug-events';

const runId = 'a'.repeat(32);
const invocationId = 'b'.repeat(32);
const entry: DockerHostExecutorEntry = {
  entryId: 'script', executorKind: 'script', config: {}, hostWritableBytes: 4096, aggregateWritableBytes: 4096,
};

describe('Docker host plan validation', () => {
  let root: string;
  let plan: HostExecutorInvocationPlan;
  let diagnostic: PublicEnclaveOperationRecorder;
  let debugCheck: DockerHostDebugCheck;

  beforeEach(() => {
    root = path.join(process.cwd(), `.docker-host-plan-validation-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    plan = {
      runId, invocationId, entryId: entry.entryId, executorKind: 'script', timeoutMs: 1000,
      requestHash: 'c'.repeat(64), admissionId: 'd'.repeat(32), schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' }, payload: 'pass',
      invocationHostDir: path.join(root, invocationId), seedId: 'f'.repeat(32), seedHostPath: path.join(root, 'seed'),
    };
    diagnostic = new PublicEnclaveOperationRecorder();
    debugCheck = (stage, operation) => diagnostic.check(stage, operation);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('accepts matching plan identity and rejects missing entries, wrong runs, kinds and invocation IDs', () => {
    expect(isDockerHostPlanIdentityValid(plan, runId, entry)).toBe(true);
    expect(isDockerHostPlanIdentityValid(plan, runId, undefined)).toBe(false);
    expect(isDockerHostPlanIdentityValid(plan, '0'.repeat(32), entry)).toBe(false);
    expect(isDockerHostPlanIdentityValid({ ...plan, executorKind: 'agent' }, runId, entry)).toBe(false);
    expect(isDockerHostPlanIdentityValid({ ...plan, invocationId: '../invalid' }, runId, entry)).toBe(false);
    expect(diagnostic.events).toEqual([]);
  });

  test('checks the invocation path before returning a basename mismatch as false', async () => {
    await expect(isDockerHostInvocationPathValid(plan, debugCheck)).resolves.toBe(true);
    await expect(isDockerHostInvocationPathValid({ ...plan, invocationHostDir: path.join(root, 'wrong') }, debugCheck))
      .resolves.toBe(false);
    expect(diagnostic.events.map(event => event.stage)).toEqual([
      'storage-preparation', 'storage-preparation', 'storage-preparation', 'storage-preparation',
    ]);
  });

  test.each(['relative/path', '/host/path:ro', '/host/../path'])('throws for unsafe invocation path %s', async target => {
    await expect(isDockerHostInvocationPathValid({ ...plan, invocationHostDir: target }, debugCheck))
      .rejects.toThrow('normalized local absolute paths');
    expect(diagnostic.primaryFailure?.stage).toBe('storage-preparation');
  });

  test('rejects symlink ancestors using the host path guard', async () => {
    fs.symlinkSync(root, path.join(root, 'link'));
    await expect(isDockerHostInvocationPathValid({
      ...plan, invocationHostDir: path.join(root, 'link', invocationId),
    }, debugCheck)).rejects.toThrow('Unsafe Docker enclave path ancestor');
  });

  test.each([
    { seedId: undefined }, { seedHostPath: undefined }, { seedId: '', seedHostPath: '' },
  ])('returns false for a missing static seed without path diagnostics: %j', async missing => {
    await expect(isDockerHostSeedValid({ ...plan, ...missing }, false, debugCheck)).resolves.toBe(false);
    expect(diagnostic.events).toEqual([]);
  });

  test('allows seedless dynamic plans but still checks any supplied seed path', async () => {
    await expect(isDockerHostSeedValid({ ...plan, seedId: undefined, seedHostPath: undefined }, true, debugCheck))
      .resolves.toBe(true);
    expect(diagnostic.events).toEqual([]);
    await expect(isDockerHostSeedValid({ ...plan, seedHostPath: '/host/seed,unsafe' }, true, debugCheck))
      .rejects.toThrow('normalized local absolute paths');
  });

  test('validates a static seed path in the storage stage', async () => {
    await expect(isDockerHostSeedValid(plan, false, debugCheck)).resolves.toBe(true);
    expect(diagnostic.events.map(event => event.stage)).toEqual(['storage-preparation', 'storage-preparation']);
  });
});
