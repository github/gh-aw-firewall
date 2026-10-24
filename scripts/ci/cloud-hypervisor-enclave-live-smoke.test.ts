import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { validateSchema, validateValueAgainstSchema } from '../../src/bounded-execution/finite-schema';
import { hostExecutorResultDigest } from '../../src/enclave/host-executor-protocol';
import type { EnclaveStartupProgress } from '../../src/enclave/startup-progress';
import {
  HostPreflightReporter, type HostPreflightCheck, type HostPreflightScope,
} from '../../src/cloud-hypervisor/host-preflight-progress';
import { schema as hostPreflightSchema } from '../../src/cloud-hypervisor/host-preflight-schema';
import {
  observeMountTopology, type MountTopologyEvidence, createStoragePropagationEvidence,
} from '../../src/cloud-hypervisor/mount-topology';
import {
  createPrimaryReadinessReporter, PRIMARY_READINESS_DIRECTORY, PRIMARY_READINESS_FILENAME,
} from '../../src/cloud-hypervisor/primary-readiness';

const root = path.resolve(__dirname, '../..');
const harnessPath = path.join(root, 'scripts/ci/cloud-hypervisor-enclave-live-smoke.js');
const workflowPath = path.join(root, '.github/workflows/test-cloud-hypervisor-enclaves.yml');
type StartupChild = { exitCode: number | null; signalCode: string | null };
type VmResidue = {
  namespaces: string[];
  processes: Array<{ pid: string; startTime: string }>;
  cgroups: Array<{ name: string; device: number; inode: number }>;
};
type PrimaryProgress = {
  schemaVersion: number; ownerPid: number; stage: string; state: string;
  bootAttempt: number; runId: string | null;
};
const harness = require(harnessPath) as {
  readPrimaryVmProgress(file: string, child: StartupChild & { pid: number }): PrimaryProgress | undefined;
  verifyPrimaryVmIdentity(
    progress: PrimaryProgress, child: StartupChild & { pid: number }, observed: VmResidue,
  ): Promise<string>;
  waitForPrimaryVmReadiness(
    child: StartupChild, deadline: number, diagnostics: { startupErrorFile: string },
    dependencies?: {
      readProgress?: () => PrimaryProgress | undefined;
      capture?: (deadline?: number) => VmResidue;
      verify?: () => Promise<string>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ): Promise<VmResidue>;
  startupDiagnostic(child: StartupChild | undefined, reason: string, stage: string, file: string, startupErrorFile?: string): {
    schemaVersion: number;
    phase: string;
    stage: string;
    reason: string;
    category: string;
    exitCode: number | null;
    signal: string | null;
    logInspection: string;
    enclaveStartup?: EnclaveStartupProgress;
  };
  startupEvidence(child: StartupChild | undefined, reason: string, stage: string, file: string, startupErrorFile?: string): {
    schemaVersion: number;
    record: { final: string; size: string | null; source: string; cachedPolls: number; cachedSize: string | null };
    stderr: { inspection: string; size: string | null; attempts: number };
    awfExit: Record<string, unknown> | null;
    awfExitMarkers: number;
    elapsed: string | null;
  };
  startupSnapshot(
    child: StartupChild | undefined, reason: string, stage: string, profile: string, file: string,
    startupErrorFile?: string,
  ): {
    stage: string; profile: string;
    diagnostic: { stage: string; reason: string; category: string; exitCode: number | null; signal: string | null };
    evidence: { stderr: { inspection: string; size: string | null; attempts: number } };
  };
  waitForHostGatewayReadiness(child: StartupChild, deadline: number, diagnostics: {
    stage: string; stderrFile: string; startupErrorFile: string;
  }): Promise<void>;
  waitForBroker(child: StartupChild, container: string, deadline: number, diagnostics: {
    stage: string; stderrFile: string; startupErrorFile?: string;
  }): Promise<void>;
  failedSpawns: WeakSet<StartupChild>;
  removePrivateAwfLogs(stdoutFile: string, stderrFile: string, startupErrorFiles?: string[]): void;
  stopAwf(child: EventEmitter & { kill(signal: string): void }, graceMs: number, terminateMs: number): Promise<void>;
  reportFailure(error: unknown, stage?: string): void;
  trackAwfChild<T extends EventEmitter & { pid?: number }>(child: T): T;
  RELEASE_ASSETS: string[];
  assertReleaseAssets(required: string[], published: string[]): void;
  assertUnifiedProfiles(artifacts: unknown, primary: unknown, enclave: unknown, sbom: unknown): void;
  assertProfileTools(response: unknown, profile: string, requestId?: number): Record<string, boolean>;
  assertProfileInitialize(response: unknown, requestId: number): Record<string, boolean>;
  captureContainerLogs(profile?: string): string[];
  assertNoSentinelLeak(directories: string[], logs: string[], sentinel: string): void;
  assertExpectedToolResult(response: unknown, requestId: number, expected: unknown, label: string): void;
  assertNoSuccessfulResult(response: unknown): void;
  killAwfForRecovery(
    child: EventEmitter & StartupChild & { kill(signal: string): boolean }, timeoutMs?: number,
  ): Promise<void>;
  withCrashRecoveryCleanup<T>(
    context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> },
    action: () => Promise<T>, cleanups: Array<{ phase: string; action: () => unknown }>,
    onCleanupFailure: () => void,
  ): Promise<T>;
  readRecoveredInvocation(directory: string, file: string): {
    after: Record<string, unknown>; records: Array<{ file: string; record: Record<string, unknown> }>;
  };
  readCrashRecoveryBaseline<T extends { runId: string; invocationId: string }>(
    directory: string, active: { file: string; record: T }, ownerPid: number,
  ): { record: T; inventory: Record<string, unknown>; baseline: Record<string, boolean> };
  assertNoVmResidue(expectedPrimary?: {
    namespaces: string[];
    processes: Array<{ pid: string; startTime: string }>;
    cgroups: Array<{ name: string; device: number; inode: number }>;
  }, observed?: {
    namespaces: string[];
    processes: Array<{ pid: string; startTime: string }>;
    cgroups: Array<{ name: string; device: number; inode: number }>;
  }): void;
  assertRecoveredInvocation(
    before: {
      runId: string;
      invocationId: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    after: {
      runId: string;
      invocationId: string;
      state: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    records: Array<{ record: { runId: string; invocationId: string } }>,
  ): Record<string, boolean>;
  buildAgentGuestProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildAgentEnospcProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildConstantObjectSchema(expected: Record<string, unknown>): unknown;
  buildEnospcProbeScript(maxStorageMib?: number): string;
  buildOomProbeScript(): string;
  buildScriptGuestProbe(): { expected: Record<string, unknown>; schema: unknown };
  parsePublicToolResult(response: unknown, requestId: number): { status: string; result?: unknown };
  assertCanonicalToolError(response: unknown, requestId: number): void;
  acceptanceCheck<T>(
    context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>>;
      observeAdmission?: () => unknown; admissionEvidence?: unknown }, step: string, phase: string,
    action: () => T | Promise<T>,
  ): Promise<T>;
  observeInvocationRecords(
    records: Array<{ file: string; record: Record<string, unknown> }>, existing: Set<string>, ownerPid: number,
  ): { counts: Record<string, string>; record?: unknown };
  resourceRecords(directory: string, inventory?: Record<string, unknown>): Array<{ file: string; record: unknown }>;
  resourceDiscoveryEvidence(
    directory: string, ownerPid: number, inventory: Record<string, unknown>,
  ): Record<string, unknown>;
  waitForInvocationRecord(
    directory: string, existing: Set<string>, ownerPid: number, timeoutMs: number,
    dependencies: { now: () => number; sleep: (ms: number) => Promise<void>;
      read: () => Array<{ file: string; record: Record<string, unknown> }> },
  ): Promise<unknown>;
  waitForInvocationOutcome(
    directory: string, identity: { runId: string; entryId: string; invocationId: string },
    expected: string, timeoutMs: number,
    dependencies: { now: () => number; sleep: (ms: number) => Promise<void>; read: () => string },
  ): Promise<void>;
  requestMcp(
    endpoint: string,
    apiKey: string,
    requestId: number,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
};

describe('sanitized host startup diagnostics', () => {
  let directory: string;
  let stderrFile: string;
  const child = { exitCode: 1, signalCode: null };
  const known = 'The Docker primary-agent runtime is unavailable; enclaves never fall back';
  const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_repository_secret_/private/path';
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-startup-diagnostic-'));
    stderrFile = path.join(directory, 'awf.stderr.log');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const diagnose = (file: string) => harness.startupDiagnostic(child, 'exit', 'initial', file);
  const progress = (update: Partial<EnclaveStartupProgress> = {}): EnclaveStartupProgress => ({
    schemaVersion: 1, perspective: 'awf-host', stage: 'initialize',
    readiness: 'attempted', code: 'dns-not-found', attempts: 1, httpStatus: null, ...update,
  });
  const publish = (value: unknown, message = sentinel, phase = 'startup') => {
    const file = path.join(directory, 'awf-startup-error.json');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: sentinel, phase, message, enclaveStartup: value,
    }));
    return file;
  };
  const standardChecklist = (): NonNullable<EnclaveStartupProgress['startupChecks']> => ({
    schemaVersion: 1, ready: false,
    checks: Object.fromEntries(Object.keys(hostPreflightSchema.scopes.startup)
      .map((id) => [`startup/${id}`, ['not-attempted', 'none']])),
  });

  const topology = (): MountTopologyEvidence => {
    const observation = observeMountTopology(
      '100 1 0:1 / /PRIVATE rw shared:1 - tmpfs SECRET rw\n' +
      '101 100 0:1 /artifacts /PRIVATE/artifacts rw shared:1 - tmpfs SECRET rw\n' +
      '102 101 0:1 /artifacts/run-secret /PRIVATE/artifacts/run-secret rw - tmpfs SECRET rw\n' +
      '103 102 0:1 /artifacts/run-secret /PRIVATE/artifacts/run-secret rw - tmpfs SECRET rw\n',
      '/PRIVATE', '/PRIVATE/artifacts', '/PRIVATE/artifacts/run-secret',
    );
    return { schemaVersion: 1, bindCalls: 'one', before: { ...observation, snapshotEntries: 'zero',
      snapshotIds: 'none', snapshotParentStack: 'absent' }, after: observation };
  };
  it.each([false, true])('preserves topology after cleanup and duplicate scope omission (%s)', (active) => {
    const mountTopology = topology();
    const value = progress({
      mountTopology, startupChecks: standardChecklist(),
      ...(active ? { hostPreflight: {
        schemaVersion: 1 as const, scope: 'artifact-snapshot' as const, mountTopology,
        checks: Object.keys(hostPreflightSchema.scopes['artifact-snapshot']).map((id) => ({
          id: id as HostPreflightCheck, result: 'not-attempted' as const, reason: 'none' as const,
        })),
      } } : {}),
    });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup?.mountTopology).toEqual(mountTopology);
    if (active) expect(result.enclaveStartup?.hostPreflight?.mountTopology).toEqual(mountTopology);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|run-secret/);
  });

  const storageEvidence = () => {
    const evidence = createStoragePropagationEvidence('/PRIVATE/root', '/PRIVATE/invocation');
    evidence.sourceBeforeBind = 'private';
    evidence.destinationBeforeBind = 'shared';
    evidence.mounts.invocationAfterBind = [1, 1, 1, 0];
    evidence.mounts.invocationVerified = [1, 1, 1, 0];
    return evidence;
  };
  it.each([false, true])('preserves storage evidence after cleanup or active scope omission (%s)', (active) => {
    const storagePropagation = storageEvidence();
    const value = progress({
      storagePropagation, startupChecks: standardChecklist(),
      ...(active ? { hostPreflight: {
        schemaVersion: 1 as const, scope: 'storage-verification' as const, storagePropagation,
        checks: Object.keys(hostPreflightSchema.scopes['storage-verification']).map((id) => ({
          id: id as HostPreflightCheck, result: 'not-attempted' as const, reason: 'none' as const,
        })),
      } } : {}),
    });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup?.storagePropagation).toEqual(storagePropagation);
    if (active) expect(result.enclaveStartup?.hostPreflight?.storagePropagation).toEqual(storagePropagation);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|run-secret/);
  });

  it.each([
    { ...storageEvidence(), path: sentinel },
    { ...storageEvidence(), invocationLocation: sentinel },
    { ...storageEvidence(), sourceBeforeBind: sentinel },
    { ...storageEvidence(), destinationBeforeBind: sentinel },
    { ...storageEvidence(), schemaVersion: 2 },
    { ...storageEvidence(), mounts: {} },
    { ...storageEvidence(), mounts: { ...storageEvidence().mounts, path: sentinel } },
    { ...storageEvidence(), mounts: { ...storageEvidence().mounts, rootVerified: [1, sentinel, 1, 0] } },
    { ...storageEvidence(), mounts: { ...storageEvidence().mounts, rootVerified: [1, 0, 1] } },
  ])('rejects unsafe storage evidence at both publication surfaces', (storagePropagation) => {
    for (const nested of [false, true]) {
      const value = nested ? {
        ...progress(), hostPreflight: {
          schemaVersion: 1, scope: 'storage-verification', storagePropagation,
          checks: Object.keys(hostPreflightSchema.scopes['storage-verification']).map((id) => ({
            id, result: 'not-attempted', reason: 'none',
          })),
        },
      } : { ...progress(), storagePropagation };
      const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
      expect(result.enclaveStartup).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
  });
  it.each([
    { ...topology(), path: sentinel },
    { ...topology(), bindCalls: sentinel },
    { ...topology(), before: { ...topology().before, path: sentinel } },
    { ...topology(), after: { ...topology().after, snapshotIds: sentinel } },
    { ...topology(), after: {} },
    { ...topology(), schemaVersion: 2 },
  ])('rejects unsafe or incomplete topology instead of echoing it', (mountTopology) => {
    const value = { ...progress(), mountTopology };
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('retains the standard cumulative checklist without exporting messages or private metadata', () => {
    const startupChecks = standardChecklist();
    startupChecks.checks['startup/enclave-preparation'] = ['failed', 'EPERM'];
    const value = progress({
      stage: 'host-preflight', code: 'none', readiness: 'not-attempted', attempts: 0, startupChecks,
    });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup?.startupChecks).toEqual(startupChecks);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
  });

  it.each([false, true])(
    'retains the full snapshot failure after cleanup, including when the duplicate active scope is omitted (%s)', (active) => {
      const startupChecks: NonNullable<EnclaveStartupProgress['startupChecks']> = {
        schemaVersion: 1, ready: false,
        checks: Object.fromEntries(Object.entries(hostPreflightSchema.scopes).flatMap(([scope, checks]) =>
          Object.keys(checks).map((id) => [`${scope}/${id}`, ['not-attempted', 'none']]))),
      };
      startupChecks.checks['artifact-snapshot/rootfs-copy'] = ['failed', 'rsync-partial-transfer'];
      startupChecks.checks['bounded-runtime/artifact-snapshot'] = ['failed', 'rsync-partial-transfer'];
      for (const id of Object.keys(hostPreflightSchema.scopes['bounded-cleanup'])) {
        startupChecks.checks[`bounded-cleanup/${id}`] = ['passed', 'none'];
      }
      const value = progress({
        stage: 'host-preflight', code: 'none', readiness: 'not-attempted', attempts: 0, startupChecks,
        ...(active ? { hostPreflight: {
          schemaVersion: 1, scope: 'bounded-cleanup',
          checks: Object.keys(hostPreflightSchema.scopes['bounded-cleanup']).map((id) => ({
            id: id as HostPreflightCheck, result: 'passed' as const, reason: 'none' as const,
          })),
        } } : {}),
      });
      const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
      expect(result.category).toBe('host-preflight');
      expect(result.enclaveStartup?.startupChecks).toEqual(startupChecks);
      expect(result.enclaveStartup?.readiness).toBe('not-attempted');
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16 * 1024);
    },
  );

  it.each([
    { ...standardChecklist(), ready: true },
    { ...standardChecklist(), path: sentinel },
    { ...standardChecklist(), checks: { 'startup/readiness': ['passed', 'none'] } },
    { ...standardChecklist(), checks: { ...standardChecklist().checks, [sentinel]: ['failed', 'EPERM'] } },
    { ...standardChecklist(), checks: { ...standardChecklist().checks, 'startup/configuration': ['not-required', 'none'] } },
    { ...standardChecklist(), checks: { ...standardChecklist().checks, 'startup/configuration': ['failed', sentinel] } },
    { ...standardChecklist(), checks: { ...standardChecklist().checks, 'startup/configuration': ['passed', 'none', sentinel] } },
  ])('rejects malformed, partial, unsafe or falsely-ready cumulative checklists', (startupChecks) => {
    const value = progress({ startupChecks: startupChecks as NonNullable<EnclaveStartupProgress['startupChecks']> });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('does not claim hosting readiness from a handshake while required storage checks remain incomplete', async () => {
    const file = publish(progress({
      stage: 'tools-list', readiness: 'ready', code: 'ready', attempts: 2,
      startupChecks: standardChecklist(),
    }), 'Enclave startup in progress', 'enclave-startup-progress');
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(harness.waitForHostGatewayReadiness(
      { exitCode: null, signalCode: null }, Date.now() + 5,
      { stage: 'initial', stderrFile, startupErrorFile: file },
    )).rejects.toThrow(/actual AWF host gateway readiness/);
    expect(output).not.toHaveBeenCalled();
  });

  it.each(Object.keys(hostPreflightSchema.scopes) as HostPreflightScope[])(
    'exports only the exact actual-host check plan for %s with readiness still not attempted', async (scope) => {
      const publishCheck = jest.fn();
      const reporter = new HostPreflightReporter(scope, publishCheck);
      const first = Object.keys(hostPreflightSchema.scopes[scope])[0] as 'root' | 'configured-role';
      await expect(reporter.check(first, () => {
        throw Object.assign(new Error(sentinel), { code: 'EPERM' });
      })).rejects.toThrow(sentinel);
      const hostPreflight = publishCheck.mock.calls[publishCheck.mock.calls.length - 1][0];
      const value = progress({
        stage: 'host-preflight', code: 'none', readiness: 'not-attempted', attempts: 0, hostPreflight,
      });
      const file = publish(value);
      const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, file);
      expect(result).toMatchObject({
        schemaVersion: 2, phase: 'host-startup', category: 'host-preflight', enclaveStartup: value,
      });
      expect(Buffer.byteLength(`AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(result)}\n`)).toBeLessThan(8192);
      expect(JSON.stringify(result)).not.toContain(sentinel);
    },
  );

  it.each([
    ['preflight', 'common'], ['execution', 'primary'],
    ['cleanup', 'script'], ['persistence', 'agent'],
  ] as const)('preserves closed v2 host preflight context %s/%s', (phase, profile) => {
    const publishCheck = jest.fn();
    new HostPreflightReporter('storage-admission', publishCheck, undefined, { phase, profile });
    const hostPreflight = publishCheck.mock.calls[0][0];
    expect(hostPreflight.schemaVersion).toBe(2);
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile,
      publish(progress({ hostPreflight })));
    expect(result.enclaveStartup?.hostPreflight).toEqual(hostPreflight);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    (value: Record<string, unknown>) => { const { phase, ...rest } = value; void phase; return rest; },
    (value: Record<string, unknown>) => { const { profile, ...rest } = value; void profile; return rest; },
    (value: Record<string, unknown>) => ({ ...value, phase: 'secret' }),
    (value: Record<string, unknown>) => ({ ...value, profile: sentinel }),
    (value: Record<string, unknown>) => ({ ...value, schemaVersion: 1 }),
    (value: Record<string, unknown>) => ({ ...value, extra: sentinel }),
  ])('rejects incomplete, unsafe, or misversioned v2 host preflight context', (mutate) => {
    const publishCheck = jest.fn();
    new HostPreflightReporter('storage-admission', publishCheck, undefined, {
      phase: 'preflight', profile: 'common',
    });
    const hostPreflight = mutate(publishCheck.mock.calls[0][0]);
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile,
      publish(progress({ hostPreflight: hostPreflight as EnclaveStartupProgress['hostPreflight'] })));
    expect(result.enclaveStartup).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    (value: Record<string, unknown>) => ({ ...value, scope: sentinel }),
    (value: Record<string, unknown>) => ({ ...value, schemaVersion: 99 }),
    (value: Record<string, unknown>) => ({ ...value, path: sentinel }),
    (value: Record<string, unknown>) => ({ ...value, checks: [] }),
    (value: Record<string, unknown>) => ({ ...value, checks: new Array(1000).fill({ id: sentinel, result: 'passed', reason: 'none' }) }),
    (value: Record<string, unknown>) => ({ ...value, checks: [{ id: 'root', result: 'failed', reason: 'none' }] }),
    (value: Record<string, unknown>) => ({ ...value, checks: [{ id: 'root', result: 'passed', reason: 'EPERM' }] }),
  ])('rejects malformed or arbitrary subcheck records without exposing them', (mutate) => {
    const publishCheck = jest.fn();
    new HostPreflightReporter('storage-admission', publishCheck);
    const hostPreflight = mutate(publishCheck.mock.calls[0][0]);
    const value = progress({ hostPreflight: hostPreflight as EnclaveStartupProgress['hostPreflight'] });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, publish(value));
    expect(result.enclaveStartup).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    { id: sentinel }, { result: sentinel }, { reason: sentinel }, { rawError: sentinel },
    { reason: 'none', result: 'failed' }, { reason: 'EPERM', result: 'passed' },
  ])('validates every nested check field and does not forward unknown fields: %p', (update) => {
    const publishCheck = jest.fn();
    new HostPreflightReporter('storage-admission', publishCheck);
    const hostPreflight = publishCheck.mock.calls[0][0];
    hostPreflight.checks[0] = { ...hostPreflight.checks[0], ...update };
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile,
      publish(progress({ hostPreflight })));
    expect(result.enclaveStartup).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    ['dns-not-found', 'dns'], ['dns-temporary', 'dns'],
    ['connection-refused', 'connectivity'], ['connection-timeout', 'connectivity'],
    ['request-timeout', 'connectivity'], ['network-unreachable', 'connectivity'],
    ['host-unreachable', 'connectivity'], ['connection-reset', 'connectivity'],
    ['transport-other', 'other'], ['http-auth', 'gateway-auth'],
    ['http-status', 'gateway-protocol'], ['malformed-json', 'gateway-protocol'],
    ['malformed-protocol', 'gateway-protocol'], ['rpc-error', 'gateway-protocol'],
    ['identity-mismatch', 'gateway-protocol'], ['tools-mismatch', 'gateway-protocol'],
    ['response-too-large', 'gateway-protocol'], ['backend-unavailable', 'gateway-readiness'],
    ['readiness-deadline', 'gateway-readiness'], ['unknown', 'unknown'],
  ])('exports only the allowlisted actual-host diagnostic code %s', (code, category) => {
    const value = progress({ code: code as EnclaveStartupProgress['code'], httpStatus: 503 });
    const file = publish(value);
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, file);
    expect(result).toEqual({
      schemaVersion: 2, phase: 'host-startup', stage: 'initial', reason: 'exit',
      category, exitCode: 1, signal: null, logInspection: 'structured', enclaveStartup: value,
    });
    const line = `AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(result)}\n`;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(640);
    expect(line).not.toContain(sentinel);
  });

  it('distinguishes an earlier host failure from an attempted but unclassified request', () => {
    const value = progress({
      stage: 'enclave-preflight', readiness: 'not-attempted', code: 'none', attempts: 0,
    });
    const file = publish(value);
    expect(harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, file))
      .toMatchObject({ category: 'unknown', enclaveStartup: value });
  });

  it('bounds schema-2 output at maximum allowed numeric and fixed-string metadata', () => {
    const file = publish(progress({
      stage: 'artifact-preflight', code: 'readiness-deadline', attempts: 1200, httpStatus: 599,
    }));
    const result = harness.startupDiagnostic(
      { exitCode: 255, signalCode: 'SIGSEGV' }, 'timeout', 'recovery', stderrFile, file,
    );
    expect(Buffer.byteLength(`AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(result)}\n`))
      .toBeLessThanOrEqual(640);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([
    { stage: sentinel }, { code: sentinel }, { perspective: 'harness' },
    { hostname: sentinel }, { attempts: 1201 }, { attempts: -1 },
    { httpStatus: sentinel }, { httpStatus: 600 }, { readiness: sentinel },
    { readiness: 'not-attempted' }, { readiness: 'ready' }, { schemaVersion: 99 },
  ])('rejects arbitrary progress metadata without disclosing it: %s', (update) => {
    const file = publish({ ...progress(), ...update });
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, file);
    expect(result.enclaveStartup).toBeUndefined();
    expect(result.category).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('does not mistake a harness handshake or broker health for actual AWF readiness', async () => {
    const file = publish(progress(), 'Enclave startup in progress', 'enclave-startup-progress');
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(harness.waitForHostGatewayReadiness(
      { exitCode: null, signalCode: null }, Date.now() + 5,
      { stage: 'initial', stderrFile, startupErrorFile: file },
    )).rejects.toThrow(/actual AWF host gateway readiness/);
    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"readiness":"attempted"'));
  });

  it('emits successful actual-host proof only after the full handshake', async () => {
    const value = progress({
      stage: 'tools-list', readiness: 'ready', code: 'ready', attempts: 2,
    });
    const file = publish(value, 'Enclave startup in progress', 'enclave-startup-progress');
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    await harness.waitForHostGatewayReadiness(
      { exitCode: null, signalCode: null }, Date.now() + 1000,
      { stage: 'initial', stderrFile, startupErrorFile: file },
    );
    expect(output).toHaveBeenCalledWith(`AWF_HOST_GATEWAY_READINESS ${JSON.stringify(value)}`);
    expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
  });

  it('preserves a real AWF exit even if a ready record remains', async () => {
    const file = publish(progress({
      stage: 'tools-list', readiness: 'ready', code: 'ready',
    }), 'Enclave startup in progress', 'enclave-startup-progress');
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(harness.waitForHostGatewayReadiness(child, Date.now() + 1000, {
      stage: 'initial', stderrFile, startupErrorFile: file,
    })).rejects.toThrow(/AWF exited/);
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    [known, 'container-runtime'],
    ['Cloud Hypervisor enclave runtime configuration is missing', 'configuration'],
    ['Preflight storage requires root-owned trusted directories', 'host-preflight'],
    ['Bounded enclave preflight requires trusted host tool "mount"', 'host-preflight'],
    ['Trusted enclave artifact has invalid content size', 'artifact'],
    ['agent enclave rootfs does not match its trusted manifest digest and size', 'artifact'],
    ['Cloud Hypervisor enclave host service could not start', 'host-service'],
    ['Trusted enclave MCP gateway container is unavailable', 'broker'],
    ['Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved', 'recovery-state'],
  ])('classifies the exact host fatal header: %s', (message, category) => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${message}\n    at ${sentinel}\n`);
    const diagnostic = diagnose(stderrFile);
    expect(diagnostic).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'exit',
      category, exitCode: 1, signal: null, logInspection: 'bounded',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(256);
  });

  it.each([
    sentinel,
    `{"message":"${known}","secret":"${sentinel}"}`,
    `[ERROR] Fatal error: Error: ${known} ${sentinel}`,
    `[ERROR] Fatal error: Error: ${sentinel}\n[ERROR] Fatal error: Error: ${known}`,
    `[ERROR] Fatal error: Error: ${sentinel}\n${known}`,
    `[WARN] ${known}\n${sentinel}`,
    `\u001b[31m[ERROR] Fatal error: Error: ${known}\u001b[39m`,
  ])('does not infer a category from arbitrary content', (input) => {
    fs.writeFileSync(stderrFile, input);
    expect(diagnose(stderrFile).category).toBe('unknown');
    expect(JSON.stringify(diagnose(stderrFile))).not.toContain(sentinel);
  });

  it('uses the fixed unsupported-host type without exporting its variable message or cause', () => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: CloudHypervisorUnsupportedHostError: ${sentinel}\n`);
    expect(diagnose(stderrFile).category).toBe('unsupported-host');
    expect(JSON.stringify(diagnose(stderrFile))).not.toContain(sentinel);
  });

  it('prefers the existing structured host startup record, matching the entire message', () => {
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
    for (const message of [
      'Trusted enclave artifact has invalid content size',
      `${known}\n${sentinel}`,
      sentinel,
    ]) {
      fs.writeFileSync(startupErrorFile, JSON.stringify({
        timestamp: sentinel, phase: 'startup', message,
      }));
      const diagnostic = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, startupErrorFile);
      expect(diagnostic).toEqual({
        schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'exit',
        category: message === 'Trusted enclave artifact has invalid content size' ? 'artifact' : 'unknown',
        exitCode: 1, signal: null, logInspection: 'structured',
      });
      expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    }
  });

  it('falls back to bounded stderr when a structured record is missing, invalid, oversized or a symlink', () => {
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    const record = JSON.stringify({ timestamp: 'test', phase: 'startup', message: known });
    fs.writeFileSync(stderrFile, sentinel);
    const assertUnknown = () => expect(harness.startupDiagnostic(
      child, 'exit', 'initial', stderrFile, startupErrorFile,
    )).toMatchObject({ category: 'unknown', logInspection: 'bounded' });
    assertUnknown();
    for (const content of [sentinel, record.replace('"startup"', '"workload"'), 'x'.repeat(16385)]) {
      fs.writeFileSync(startupErrorFile, content);
      assertUnknown();
    }
    fs.unlinkSync(startupErrorFile);
    const target = path.join(directory, 'structured-private');
    fs.writeFileSync(target, record);
    fs.symlinkSync(target, startupErrorFile);
    assertUnknown();
  });

  it('rejects missing, oversized, symlink and non-regular diagnostics without echoing errors', () => {
    const assertUnavailable = () => expect(diagnose(stderrFile)).toMatchObject({
      category: 'unknown', logInspection: 'unavailable',
    });
    assertUnavailable();
    const target = path.join(directory, 'private');
    fs.writeFileSync(target, `[ERROR] Fatal error: Error: ${known}`);
    fs.symlinkSync(target, stderrFile);
    assertUnavailable();
    fs.unlinkSync(stderrFile);
    fs.mkdirSync(stderrFile);
    assertUnavailable();
  });

  it('rejects an in-place change during the descriptor-bounded read and closes the descriptor', () => {
    const content = `[ERROR] Fatal error: Error: ${known}`;
    fs.writeFileSync(stderrFile, content);
    const nodeFs = require('fs') as typeof fs;
    const originalRead = fs.readSync;
    const read = jest.spyOn(nodeFs, 'readSync').mockImplementation((...args) => {
      const result = originalRead(...args);
      fs.writeFileSync(stderrFile, 'x'.repeat(Buffer.byteLength(content)));
      fs.utimesSync(stderrFile, 0, 1000);
      return result;
    });
    const close = jest.spyOn(nodeFs, 'closeSync');
    expect(diagnose(stderrFile)).toMatchObject({ category: 'unknown', logInspection: 'unavailable' });
    expect(close).toHaveBeenCalledWith(read.mock.calls[0][0]);
  });

  it('does not follow a pathname replaced after opening', () => {
    fs.writeFileSync(stderrFile, sentinel);
    const nodeFs = require('fs') as typeof fs;
    const originalFstat = fs.fstatSync;
    let replaced = false;
    jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(stderrFile, path.join(directory, 'original'));
        fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
      }
      return result;
    });
    expect(diagnose(stderrFile).category).toBe('unknown');
  });

  it.each([
    [{ exitCode: 1, signalCode: null }, 'exit'],
    [{ exitCode: null, signalCode: 'SIGKILL' }, 'signal'],
    [{ exitCode: null, signalCode: null }, 'timeout'],
    [{ exitCode: null, signalCode: null }, 'spawn-failure'],
  ])('emits before cleanup and preserves failure for %s / %s', async (status, reason) => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
    const stdoutFile = path.join(directory, 'awf.stdout.log');
    fs.writeFileSync(stdoutFile, sentinel);
    if (reason === 'spawn-failure') harness.failedSpawns.add(status);
    const records: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((record) => {
      expect(fs.existsSync(stderrFile)).toBe(true);
      records.push(record);
    });
    try {
      await expect(harness.waitForBroker(status, 'unused', reason === 'timeout' ? 0 : Date.now() + 1000, {
        stage: 'recovery', stderrFile,
      })).rejects.toThrow(/AWF|Timed out/);
    } finally {
      harness.removePrivateAwfLogs(stdoutFile, stderrFile);
    }
    expect(records).toHaveLength(2);
    expect(records[0]).toMatch(/^AWF_HOST_STARTUP_DIAGNOSTIC /);
    expect(records[1]).toMatch(/^AWF_HOST_STARTUP_EVIDENCE /);
    expect(records[1]).not.toContain(sentinel);
    expect(JSON.parse(records[1].slice('AWF_HOST_STARTUP_EVIDENCE '.length)).stderr.inspection)
      .toBe(reason === 'spawn-failure' ? 'not-attempted' : 'ok');
    const record = JSON.parse(records[0].slice('AWF_HOST_STARTUP_DIAGNOSTIC '.length));
    expect(record).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'recovery', reason,
      category: reason === 'spawn-failure' ? 'unknown' : 'container-runtime',
      exitCode: status.exitCode, signal: status.signalCode,
      logInspection: reason === 'spawn-failure' ? 'unavailable' : 'bounded',
    });
    expect(records[0]).not.toContain(sentinel);
    expect(Buffer.byteLength(`${records[0]}\n`)).toBeLessThanOrEqual(256);
    expect(fs.existsSync(stderrFile)).toBe(false);
    expect(fs.existsSync(stdoutFile)).toBe(false);
  });

  const exitMarker = (update: Record<string, unknown> = {}) => `AWF_STARTUP_EXIT ${JSON.stringify({
    schemaVersion: 1, path: 'fatal', exitCode: 1, stage: 'containers',
    failedCheck: 'startup/infrastructure', containersStarted: true, agentStarted: false,
    recordWrite: 'written', lastProgressWrite: 'written', progressWriteFailures: 0,
    cleanup: 'completed', recordAfterCleanup: 'missing', elapsed: '<10m', ...update,
  })}`;

  it('scans the stable tail of very large stderr for the fatal header and exit marker', () => {
    const fd = fs.openSync(stderrFile, 'w');
    fs.writeSync(fd, `[ERROR] Fatal error: Error: ${sentinel}\n`);
    fs.writeSync(fd, 'x'.repeat(8 * 1024 * 1024));
    fs.writeSync(fd, `\n${exitMarker()}\n[ERROR] Fatal error: Error: ${known}\n`);
    fs.closeSync(fd);
    const evidence = harness.startupEvidence(child, 'exit', 'initial', stderrFile);
    expect(evidence.stderr).toEqual({ inspection: 'tail', size: '>8MiB', attempts: 1 });
    expect(evidence.awfExit).toMatchObject({ path: 'fatal', stage: 'containers', recordAfterCleanup: 'missing' });
    expect(diagnose(stderrFile)).toMatchObject({ category: 'container-runtime', logInspection: 'bounded' });
    expect(JSON.stringify(evidence)).not.toContain(sentinel);
  });

  it('reads stderr above the former 64 KiB bound in full', () => {
    fs.writeFileSync(stderrFile, `${'x'.repeat(64 * 1024)}\n[ERROR] Fatal error: Error: ${known}\n`);
    expect(harness.startupEvidence(child, 'exit', 'initial', stderrFile).stderr)
      .toEqual({ inspection: 'ok', size: '<=1MiB', attempts: 1 });
    expect(diagnose(stderrFile).category).toBe('container-runtime');
  });

  it('snapshots each launch with its own stage, profile, exit and stderr evidence', () => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}\n`);
    const recovery = harness.startupSnapshot(
      { exitCode: null, signalCode: 'SIGKILL' }, 'signal', 'recovery', 'combined', stderrFile,
    );
    fs.writeFileSync(stderrFile, 'later launch output\n');
    const profile = harness.startupSnapshot(
      { exitCode: 1, signalCode: null }, 'exit', 'script-only', 'script-only', stderrFile,
    );
    expect(recovery).toMatchObject({
      stage: 'recovery', profile: 'combined',
      diagnostic: { stage: 'recovery', reason: 'signal', signal: 'SIGKILL', category: 'container-runtime' },
      evidence: { stderr: { inspection: 'ok' } },
    });
    expect(profile).toMatchObject({
      stage: 'script-only', profile: 'script-only',
      diagnostic: { stage: 'initial', reason: 'exit', exitCode: 1, category: 'unknown' },
      evidence: { stderr: { inspection: 'ok' } },
    });
  });

  it('retries a changing stderr file on the same inode and reports instability', () => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
    const nodeFs = require('fs') as typeof fs;
    const originalRead = fs.readSync;
    let reads = 0;
    jest.spyOn(nodeFs, 'readSync').mockImplementation((...args) => {
      const result = originalRead(...args);
      reads += 1;
      if (reads <= 2) fs.appendFileSync(stderrFile, 'x');
      return result;
    });
    const evidence = harness.startupEvidence(child, 'exit', 'initial', stderrFile);
    expect(evidence.stderr.inspection).toBe('ok');
    expect(evidence.stderr.attempts).toBeGreaterThan(1);
  });

  it('reports a replaced pathname during retries without reading it', () => {
    fs.writeFileSync(stderrFile, sentinel);
    const nodeFs = require('fs') as typeof fs;
    const originalRead = fs.readSync;
    let first = true;
    jest.spyOn(nodeFs, 'readSync').mockImplementation((...args) => {
      const result = originalRead(...args);
      if (first) {
        first = false;
        fs.appendFileSync(stderrFile, 'x');
        fs.renameSync(stderrFile, path.join(directory, 'original'));
        fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
      }
      return result;
    });
    expect(harness.startupEvidence(child, 'exit', 'initial', stderrFile).stderr.inspection).toBe('replaced');
  });

  it.each([
    { path: sentinel }, { stage: sentinel }, { failedCheck: sentinel }, { failedCheck: 'startup/unknown' },
    { failedCheck: 'constructor/name' }, { failedCheck: 'constructor/prototype' },
    { recordWrite: sentinel }, { cleanup: sentinel }, { elapsed: sentinel }, { exitCode: 999 },
    { message: sentinel }, { progressWriteFailures: -1 },
  ])('rejects malformed or unsafe exit markers: %p', (update) => {
    fs.writeFileSync(stderrFile, `${exitMarker(update)}\n`);
    const evidence = harness.startupEvidence(child, 'exit', 'initial', stderrFile);
    expect(evidence.awfExit).toBeNull();
    expect(evidence.awfExitMarkers).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(sentinel);
  });

  it('uses the last valid exit marker so post-cleanup state wins', () => {
    fs.writeFileSync(stderrFile, `${exitMarker({ cleanup: 'pending', recordAfterCleanup: 'unknown' })}\n`
      + `${exitMarker()}\n`);
    expect(harness.startupEvidence(child, 'exit', 'initial', stderrFile).awfExit)
      .toMatchObject({ cleanup: 'completed', recordAfterCleanup: 'missing' });
  });

  it('accepts structured records above the former 16 KiB bound', () => {
    const startupChecks: NonNullable<EnclaveStartupProgress['startupChecks']> = {
      schemaVersion: 1, ready: false,
      checks: Object.fromEntries(Object.entries(hostPreflightSchema.scopes).flatMap(([scope, checks]) =>
        Object.keys(checks).map((id) => [`${scope}/${id}`, ['not-attempted', 'none']]))),
    };
    const file = path.join(directory, 'awf-startup-error.json');
    fs.writeFileSync(file, JSON.stringify({
      timestamp: 'x'.repeat(16 * 1024), phase: 'startup', message: sentinel,
      enclaveStartup: progress({ startupChecks }),
    }));
    const result = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, file);
    expect(result.logInspection).toBe('structured');
    expect(harness.startupEvidence(child, 'exit', 'initial', stderrFile, file).record)
      .toMatchObject({ final: 'valid', size: '<=64KiB', source: 'final' });
  });

  it('recovers the last validated record after AWF cleanup removes it', async () => {
    const value = progress({ stage: 'containers', readiness: 'not-attempted', code: 'none', attempts: 0 });
    const file = publish(value, 'Enclave startup in progress', 'enclave-startup-progress');
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}\n`);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const running = { exitCode: null as number | null, signalCode: null };
    const inspect = jest.fn(() => {
      fs.rmSync(file);
      running.exitCode = 1;
      return { status: 1, stdout: '' };
    });
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawnSync: inspect,
    }));
    try {
      let isolatedHarness!: typeof harness;
      jest.isolateModules(() => { isolatedHarness = require(harnessPath); });
      await expect(isolatedHarness.waitForBroker(running, 'awf-test-missing-container', Date.now() + 10_000, {
        stage: 'initial', stderrFile, startupErrorFile: file,
      })).rejects.toThrow(/AWF exited/);
      expect(inspect).toHaveBeenCalledTimes(1);
      const evidence = isolatedHarness.startupEvidence(running, 'exit', 'initial', stderrFile, file);
      expect(evidence.record).toMatchObject({ final: 'missing', source: 'cached' });
      expect(evidence.record.cachedPolls).toBeGreaterThan(0);
      expect(isolatedHarness.startupDiagnostic(running, 'exit', 'initial', stderrFile, file))
        .toMatchObject({ category: 'container-runtime', logInspection: 'structured', enclaveStartup: value });
    } finally {
      jest.dontMock('child_process');
    }
  });

  it('bounds all metadata even for malformed child state', () => {
    expect(harness.startupDiagnostic({
      exitCode: 9999, signalCode: sentinel,
    }, sentinel, sentinel, stderrFile)).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'unknown',
      category: 'unknown', exitCode: null, signal: null, logInspection: 'unavailable',
    });
  });

  it('does not emit startup diagnostics once the broker has become ready', async () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    let isolatedHarness!: typeof harness;
    const inspect = jest.fn(() => ({ status: 0, stdout: 'healthy\n' }));
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawnSync: inspect,
    }));
    try {
      jest.isolateModules(() => { isolatedHarness = require(harnessPath); });
      const running = { exitCode: null, signalCode: null };
      await expect(isolatedHarness.waitForBroker(running, 'broker', Date.now() + 1000, {
        stage: 'initial', stderrFile,
      })).resolves.toBeUndefined();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]).toEqual([
        'docker',
        ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', 'broker'],
        expect.objectContaining({ timeout: expect.any(Number), killSignal: 'SIGKILL' }),
      ]);
      expect(output).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
    }
  });

  it.each(['exit', 'signal', 'spawn-failure'])('handles an actual child %s without disclosing a subprocess error', async (reason) => {
    fs.writeFileSync(stderrFile, sentinel);
    const childProcess = harness.trackAwfChild(reason === 'spawn-failure'
      ? spawn(path.join(directory, 'missing-private-executable'))
      : spawn(process.execPath, ['-e', reason === 'exit'
        ? 'process.exit(1)' : 'process.kill(process.pid, "SIGTERM")']));
    await new Promise<void>((resolve) => childProcess.once('close', () => resolve()));
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(harness.waitForBroker(childProcess, 'unused', Date.now() + 1000, {
      stage: 'initial', stderrFile,
    })).rejects.toThrow(/AWF/);
    const record = String(output.mock.calls[0][0]);
    expect(JSON.parse(record.slice('AWF_HOST_STARTUP_DIAGNOSTIC '.length)))
      .toMatchObject({ reason, category: 'unknown', phase: 'pre-broker' });
    expect(record).not.toContain(directory);
    expect(record).not.toContain(sentinel);
  });

  it('attempts removal of every raw file despite a cleanup error without exposing it', () => {
    const stdoutFile = path.join(directory, 'awf.stdout.log');
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    const primaryFile = path.join(directory, PRIMARY_READINESS_DIRECTORY, PRIMARY_READINESS_FILENAME);
    fs.mkdirSync(path.dirname(primaryFile), { recursive: true });
    for (const file of [stdoutFile, stderrFile, startupErrorFile, primaryFile]) fs.writeFileSync(file, sentinel);
    const nodeFs = require('fs') as typeof fs;
    const originalRemove = fs.rmSync;
    const remove = jest.spyOn(nodeFs, 'rmSync').mockImplementation((...args) => {
      if (args[0] === stdoutFile) throw new Error(sentinel);
      originalRemove(...args);
    });
    expect(() => harness.removePrivateAwfLogs(stdoutFile, stderrFile, [startupErrorFile]))
      .toThrow('Could not remove live enclave private diagnostic files');
    expect(remove).toHaveBeenCalledTimes(4);
    expect(fs.existsSync(stderrFile)).toBe(false);
    expect(fs.existsSync(startupErrorFile)).toBe(false);
    expect(fs.existsSync(primaryFile)).toBe(false);
  });

  it('bounds cleanup after startup timeout and clears timers after normal exit', async () => {
    jest.useFakeTimers();
    try {
      const stuck = Object.assign(new EventEmitter(), { kill: jest.fn() });
      const pending = harness.stopAwf(stuck, 60_000, 5000);
      const rejection = expect(pending).rejects.toThrow('AWF did not exit within the live fixture cleanup deadline');
      jest.advanceTimersByTime(60_000);
      expect(stuck.kill).toHaveBeenCalledWith('SIGTERM');
      jest.advanceTimersByTime(5000);
      await rejection;
      expect(stuck.kill).toHaveBeenCalledWith('SIGKILL');
      expect(stuck.listenerCount('exit')).toBe(0);
      const normal = Object.assign(new EventEmitter(), { kill: jest.fn() });
      const stopped = harness.stopAwf(normal, 60_000, 5000);
      normal.emit('exit', 0);
      await expect(stopped).resolves.toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      expect(normal.kill).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains projections before raw-log cleanup, including retained recovery state', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("stage: 'initial', stderrFile: awfErr");
    expect(source).toContain("stage: 'recovery', stderrFile: awfErr");
    expect(source).toContain("NO_COLOR: '1', FORCE_COLOR: '0'");
    expect(source.indexOf('removePrivateAwfLogs(awfOut, awfErr,'))
      .toBeLessThan(source.indexOf('if (keepArtifacts) {'));
    expect(source.indexOf('conformanceDiagnostics.collect('))
      .toBeLessThan(source.indexOf('removePrivateAwfLogs(awfOut, awfErr,'));
    expect(fs.readFileSync(workflowPath, 'utf8')).toContain('/live/upload/*.json');
  });
});

describe('Cloud Hypervisor enclave live acceptance harness', () => {
  it('accepts the four unified profile configurations only with common base lineage and one final enclave rootfs', () => {
    const hash = 'a'.repeat(64);
    const baseId = `sha256:${'b'.repeat(64)}`;
    const image = 'ghcr.io/github/gh-aw-firewall/cloud-hypervisor-guest-base@sha256:abc';
    const source = 'ghcr.io/github/gh-aw-firewall/cloud-hypervisor-enclave@sha256:def';
    const artifacts = {
      directory: '/release', enclaveDirectory: '/release/enclave', tag: 'v1',
      enclaveArtifactEnvironment: {
        AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: '/release/enclave/enclave-rootfs.ext4',
        AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: '/release/enclave/enclave-rootfs.ext4',
        AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: '/release/enclave/enclave-rootfs.ext4',
      },
    };
    const primary = {
      userspace: { baseImage: image, baseImageId: baseId },
      artifacts: { rootfs: { file: 'rootfs.ext4', sha256: 'c'.repeat(64) } },
    };
    const enclave = {
      schemaVersion: 2,
      guestBase: { image, imageId: baseId },
      rootfs: { file: 'enclave-rootfs.ext4', sha256: hash, sourceImage: source, sourceImageDigest: 'd'.repeat(64) },
    };
    const sbom = { packages: [
      { SPDXID: 'SPDXRef-Rootfs', checksums: [{ algorithm: 'SHA256', checksumValue: hash }] },
      { SPDXID: 'SPDXRef-SourceImage', versionInfo: 'd'.repeat(64),
        externalRefs: [{ referenceLocator: source }] },
    ] };
    expect(() => harness.assertUnifiedProfiles(artifacts, primary, enclave, sbom)).not.toThrow();
    const build = fs.readFileSync(path.join(root, 'guest/cloud-hypervisor/build-test-artifacts.sh'), 'utf8');
    const generator = fs.readFileSync(path.join(root, 'guest/cloud-hypervisor/generate-enclave-rootfs-sbom.mjs'), 'utf8');
    expect(build).toContain('"baseImageId": "${guest_base_image_id}"');
    expect(build).toContain('"imageId": "${guest_base_image_id}"');
    expect(build).toContain('"sourceImageDigest": "${enclave_image_digest}"');
    expect(generator).toContain("SPDXID: 'SPDXRef-Rootfs'");
    expect(generator).toContain("SPDXID: 'SPDXRef-SourceImage'");
    expect(generator).toContain("versionInfo: args['source-image-digest']");
    expect(generator).toContain("referenceLocator: args['source-image']");
    expect(() => harness.assertUnifiedProfiles(artifacts, {
      ...primary, userspace: { ...primary.userspace, baseImageId: `sha256:${'e'.repeat(64)}` },
    }, enclave, sbom)).toThrow(/base image/);
    expect(() => harness.assertUnifiedProfiles(artifacts, primary, {
      ...enclave, rootfs: { ...enclave.rootfs, sha256: 'f'.repeat(64) },
    }, sbom)).toThrow(/rootfs metadata/);
    expect(() => harness.assertUnifiedProfiles(artifacts, primary, enclave, {
      ...sbom, packages: [sbom.packages[0], { ...sbom.packages[1], versionInfo: 'e'.repeat(64) }],
    })).toThrow(/rootfs metadata/);
    expect(() => harness.assertUnifiedProfiles({
      ...artifacts, enclaveArtifactEnvironment: {
        ...artifacts.enclaveArtifactEnvironment,
        AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: '/release/enclave/other.ext4',
      },
    }, primary, enclave, sbom)).toThrow(/same final enclave rootfs/);
  });

  it('requires the exact enabled tools per live single-executor and combined profile', () => {
    const listing = (names: string[]) => ({
      result: { tools: names.map((name) => ({ name })) },
    });
    expect(() => harness.assertProfileTools(listing(['enclave_run_script']), 'script-only')).not.toThrow();
    expect(() => harness.assertProfileTools(listing(['enclave_run_agent']), 'agent-only')).not.toThrow();
    expect(() => harness.assertProfileTools(listing(['enclave_run_script', 'enclave_run_agent']), 'combined')).not.toThrow();
    for (const profile of ['script-only', 'agent-only', 'combined']) {
      expect(() => harness.assertProfileTools(listing([]), profile)).toThrow(/configured executors/);
      if (profile !== 'combined') {
        expect(() => harness.assertProfileTools(listing(['enclave_run_script', 'enclave_run_agent']), profile))
          .toThrow(/configured executors/);
      }
    }
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("for (const profile of ['script-only', 'agent-only'])");
    expect(source).toContain("writeAwfConfig(workDir, awfConfigPath, profile)");
    expect(source).toContain("waitForHostGatewayReadiness(awf, Date.now() + 150_000, diagnostics)");
    expect(source).toContain("assertExpectedToolResult(response, requestId + 2, scriptProbe.expected, 'script-only profile')");
    expect(source).toContain("assertExpectedToolResult(response, requestId + 2, agentResultValue, 'agent-only profile')");
  });

  it('requires the package-matched release assets, never development artifacts', () => {
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, harness.RELEASE_ASSETS))
      .not.toThrow();
    const compressedAssets = harness.RELEASE_ASSETS.map((asset) => (
      asset.endsWith('.ext4') ? `${asset}.gz` : asset
    ));
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, compressedAssets))
      .not.toThrow();
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS,
      compressedAssets.filter((asset) => asset !== 'enclave-rootfs.ext4.gz')))
      .toThrow(/enclave-rootfs\.ext4/);
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, []))
      .toThrow(/release-attested.*not accepted/);
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('setup-enclave-artifacts.sh');
    expect(source).toContain("run('gh', [");
    expect(source).toContain(
      "apiTimeoutMs: require('../../dist/types/runtime-options').CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS",
    );
    expect(source).not.toMatch(/DEVELOPMENT_ALLOW_UNATTESTED|allow-unattested|fake.?vm|mock.?manager/i);
  });

  it('accepts only canonical bounded public MCP results', () => {
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 3,
      result: {
        structuredContent: { status: 'ok', result: true },
        content: [{ type: 'text', text: '{"status":"ok","result":true}' }],
      },
    }, 3)).toEqual({ status: 'ok', result: true });
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 4,
      result: {
        structuredContent: { status: 'error' },
        content: [{ type: 'text', text: '{"status":"error"}' }],
      },
    }, 4)).toEqual({ status: 'error' });
    for (const invalid of [
      { jsonrpc: '2.0', id: 3, error: { message: 'failed' } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', debug: 'raw' }, content: [] } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', result: true }, content: [{ type: 'text', text: '{"status":"error"}' }] } },
    ]) {
      expect(() => harness.parsePublicToolResult(invalid, 3)).toThrow();
    }
  });

  it('requires live agent identity, capabilities, API proxy peer/port, and denial of unrelated routes', () => {
    const probe = harness.buildAgentGuestProbe();
    expect(probe.expected).toEqual({
      uid: 65534,
      gid: 65534,
      onlyExpectedInterfaces: true,
      emptyEffectiveCapabilities: true,
      noNewPrivileges: true,
      processLimit: 47,
      fileSizeLimit: 268435456,
      openFileLimit: 1024,
      apiProxyReachable: true,
      wrongPortBlocked: true,
      wrongPeerBlocked: true,
      githubPeerBlocked: true,
      publicEgressBlocked: true,
    });
    expect(probe.prompt).toContain('172.31.0.30", 10002');
    expect(probe.prompt).toContain('172.31.0.30", 10000');
    expect(probe.prompt).toContain('172.31.0.99", 10002');
    expect(probe.prompt).toContain('172.31.0.40", 8080');
    expect(probe.prompt).toContain('1.1.1.1", 443');
    const python = probe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(Buffer.byteLength(probe.prompt)).toBeLessThanOrEqual(4096);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-probe>", "exec")'], {
      input: python,
    })).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: probe.expected },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: probe.expected }) }],
      },
    }, 5, probe.expected, 'agent')).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: { ...probe.expected, wrongPortBlocked: false } },
        content: [{ type: 'text', text: JSON.stringify({
          status: 'ok', result: { ...probe.expected, wrongPortBlocked: false },
        }) }],
      },
    }, 5, probe.expected, 'agent')).toThrow(/guest assertion failed/);
  });

  it('exercises guest-visible aggregate ENOSPC and verifies the bounded probe cleans its data', () => {
    const script = harness.buildEnospcProbeScript();
    expect(script).toContain('errno.ENOSPC');
    expect(script).toContain('"/output"');
    expect(script).toContain('os.unlink(name)');
    expect(script).toContain('range(16)');
    expect(() => harness.buildEnospcProbeScript(768)).toThrow(/supported role ceiling/);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<enospc-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
    const agentProbe = harness.buildAgentEnospcProbe();
    expect(agentProbe.expected).toEqual({ enospcObserved: true, probeFilesRemoved: true });
    expect(Buffer.byteLength(agentProbe.prompt)).toBeLessThanOrEqual(4096);
    const agentScript = agentProbe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(agentScript).toContain('range(8)');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-enospc-probe>", "exec")'], {
      input: agentScript,
    })).not.toThrow();
    expect(agentProbe.prompt).toContain('print(encoded)');
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 6,
      result: {
        structuredContent: {
          status: 'ok',
          result: { enospcObserved: true, probeFilesRemoved: true },
        },
        content: [{
          type: 'text',
          text: '{"status":"ok","result":{"enospcObserved":true,"probeFilesRemoved":true}}',
        }],
      },
    }, 6, { enospcObserved: true, probeFilesRemoved: true }, 'ENOSPC')).not.toThrow();
  });

  it('requires a guest OOM kill counter increase, not merely an error response', () => {
    const script = harness.buildOomProbeScript();
    expect(script).toContain('"/proc/vmstat"');
    expect(script).toContain('name == "oom_kill"');
    expect(script).toContain('signal == -9');
    expect(script).toContain('after > before');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<oom-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
  });

  it.each(['success', 'output-failure', 'cleanup-failure', 'diagnostic-failure', 'both-fail',
    'wrong-link', 'regular-link', 'broken-link', 'direct-read-failure', 'alias-read-failure',
    'link-lstat-failure', 'link-readlink-failure', 'direct-stat-failure', 'alias-stat-failure',
    'direct-close-failure', 'alias-close-failure'])(
    'observes the real storage probe boundaries under %s without allocating disk', scenario => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-probe-milestones-'));
      try {
        const result = JSON.parse(execFileSync('python3', ['-c', String.raw`
import builtins, contextlib, errno, io, json, os, sys
root, scenario = sys.argv[1:]
source = sys.stdin.read()
real_open, real_write, real_close = os.open, os.write, os.close
real_file, real_exists = builtins.open, os.path.exists
real_lstat, real_stat, real_readlink = os.lstat, os.stat, os.readlink
marker = root + "/marker.jsonl"
output = root + "/out"
alias = root + "/alias"
source = source.replace('"/output/out"', json.dumps(output)).replace('"/awf/out"', json.dumps(alias))
if scenario == "regular-link":
    with real_file(alias, "wb") as handle: handle.write(b"false")
else:
    target = output
    if scenario in ("wrong-link", "broken-link"):
        target = root + "/other"
        if scenario == "wrong-link":
            with real_file(target, "wb") as handle: handle.write(b"false")
    os.symlink(target, alias)
probe_fd = 100000
def open_fd(name, flags, mode=0o777):
    if name == "/tmp/.awf-enclave-storage-probe.jsonl":
        if scenario in ("diagnostic-failure", "both-fail"):
            raise PermissionError(errno.EACCES, "PRIVATE_DIAGNOSTIC_ERROR")
        return real_open(marker, flags, mode)
    if name.startswith("/output/.awf-live-enospc-"):
        return probe_fd
    if name in (output, alias):
        return real_open(name, flags, mode)
    raise AssertionError("unexpected file")
def write_fd(fd, data):
    if fd == probe_fd:
        raise OSError(errno.EIO if scenario == "both-fail" else errno.ENOSPC, "PRIVATE_PROBE_ERROR")
    return real_write(fd, data)
def unlink(name):
    if scenario == "cleanup-failure":
        raise PermissionError(errno.EACCES, "PRIVATE_CLEANUP_ERROR")
def open_file(name, *args, **kwargs):
    if name not in (output, alias):
        raise AssertionError("unexpected output")
    if scenario == "output-failure":
        raise OSError(errno.EIO, "PRIVATE_OUTPUT_ERROR")
    handle = real_file(name, *args, **kwargs)
    if args and args[0] == "rb":
        label = "direct" if name == output else "alias"
        class Reader:
            def read(self, size):
                assert size == 1025
                if scenario == label + "-read-failure":
                    raise OSError(errno.EIO, "PRIVATE_READ_ERROR")
                return handle.read(size)
            def close(self):
                handle.close()
                if scenario == label + "-close-failure":
                    raise OSError(errno.EIO, "PRIVATE_CLOSE_ERROR")
        return Reader()
    return handle
def inspect(operation, action):
    if scenario == operation + "-failure":
        raise OSError(errno.EIO, "PRIVATE_INSPECT_ERROR")
    return action()
os.lstat = lambda name: inspect("link-lstat", lambda: real_lstat(name))
os.readlink = lambda name: inspect("link-readlink", lambda: real_readlink(name))
os.stat = lambda name: inspect("direct-stat" if name == output else "alias-stat", lambda: real_stat(name))
os.open, os.write = open_fd, write_fd
os.close = lambda fd: None if fd == probe_fd else real_close(fd)
os.unlink = unlink
os.path.exists = lambda name: False if name.startswith("/output/.awf-live-enospc-") else real_exists(name)
builtins.open = open_file
captured, errors, failure = io.StringIO(), io.StringIO(), None
with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(errors):
    try:
        exec(compile(source, "<reviewed-storage-probe>", "exec"), {})
    except OSError as error:
        failure = error.errno
os.lstat, os.stat, os.readlink = real_lstat, real_stat, real_readlink
milestones = []
if real_exists(marker):
    with real_file(marker, encoding="ascii") as handle:
        milestones = [json.loads(line) for line in handle]
value = None
if real_exists(output):
    with real_file(output, encoding="utf8") as handle:
        value = json.load(handle)
print(json.dumps({"milestones": milestones, "output": value, "failure": failure, "errors": errors.getvalue()}))
`, directory, scenario], {
          input: harness.buildEnospcProbeScript(512), encoding: 'utf8',
        }));
        if (!['output-failure', 'cleanup-failure', 'both-fail'].includes(scenario)) {
          expect(result.failure).toBeNull();
          expect(result.output).toEqual({ enospcObserved: true, probeFilesRemoved: true });
        } else {
          expect(result.failure).toBe(scenario === 'cleanup-failure' ? 13 : 5);
          expect(result.output).toBeNull();
        }
        const stages = result.milestones.map((item: { stage: string }) => item.stage);
        if (scenario === 'success') {
          expect(stages).toEqual([
            'started', 'storage-complete', 'cleanup-started', 'cleanup-complete',
            'output-write-started', 'output-write-complete',
            'output-verified',
          ]);
          expect(result.milestones[1].enospcObserved).toBe(true);
          expect(result.milestones[3].probeFilesRemoved).toBe(true);
          expect(result.milestones[result.milestones.length - 1]).toEqual({
            stage: 'output-verified', symlink: true, targetMatches: true, sameFile: true,
            directReadable: true, aliasReadable: true, directMatchesExpected: true, aliasMatchesExpected: true,
          });
        } else if (scenario === 'output-failure') {
          expect(stages[stages.length - 1]).toBe('output-write-started');
        } else if (scenario === 'cleanup-failure') {
          expect(stages[stages.length - 1]).toBe('cleanup-started');
        } else if (scenario === 'diagnostic-failure' || scenario === 'both-fail') {
          expect(stages).toEqual([]);
          expect(result.errors).toContain('AWF_ENCLAVE_PROBE_DIAGNOSTIC write-failed');
        } else {
          const verification = result.milestones[result.milestones.length - 1];
          expect(verification.stage).toBe('output-verified');
          expect(verification.directMatchesExpected).toBe(scenario !== 'direct-read-failure');
          expect(verification.aliasMatchesExpected).toBe(
            !['wrong-link', 'regular-link', 'broken-link', 'alias-read-failure'].includes(scenario),
          );
          expect(verification.targetMatches).toBe(
            !['wrong-link', 'regular-link', 'broken-link', 'link-lstat-failure', 'link-readlink-failure'].includes(scenario),
          );
          if (scenario.endsWith('-failure')) {
            expect(result.milestones).toContainEqual({
              stage: 'output-check-failed', operation: scenario.slice(0, -'-failure'.length), errno: 5,
            });
          }
          if (scenario === 'wrong-link' || scenario === 'regular-link' || scenario === 'broken-link') {
            expect(verification.sameFile).toBe(false);
          }
        }
        expect(JSON.stringify(result.milestones)).not.toContain(directory);
        expect(result.errors).not.toContain('PRIVATE_');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('uses the production finite-schema grammar for every live response contract', () => {
    const scriptProbe = harness.buildScriptGuestProbe();
    const agentProbe = harness.buildAgentGuestProbe();
    const agentEnospc = harness.buildAgentEnospcProbe();
    const scriptEnospcExpected = { enospcObserved: true, probeFilesRemoved: true };
    const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
    const schemasAndValues = [
      [scriptProbe.schema, scriptProbe.expected],
      [agentProbe.schema, agentProbe.expected],
      [agentEnospc.schema, agentEnospc.expected],
      [harness.buildConstantObjectSchema(scriptEnospcExpected), scriptEnospcExpected],
      [harness.buildConstantObjectSchema(oomExpected), oomExpected],
      [{ type: 'enum', values: ['AWF_ENCLAVE_LIVE_AGENT_RESULT'] }, 'AWF_ENCLAVE_LIVE_AGENT_RESULT'],
      [{ type: 'const', value: true }, true],
    ] as const;
    for (const [rawSchema, value] of schemasAndValues) {
      const parsed = validateSchema(rawSchema);
      expect(parsed.valid).toBe(true);
      if (parsed.valid) expect(validateValueAgainstSchema(parsed.schema, value)).toBe(true);
    }
  });

  it('requires identity-checked crash recovery without accepting replayed success', () => {
    const before = {
      runId: 'a'.repeat(32),
      invocationId: 'b'.repeat(32),
      state: 'pending',
      directory: '/host/invocation',
      directoryIdentity: { device: 1, inode: 2 },
      ancestors: [{ path: '/host', identity: { device: 1, inode: 3 } }],
      mount: { mountId: 1, device: 2 },
      snapshot: { path: '/storage/artifacts/run-1', identity: { device: 3, inode: 4 } },
      storage: {
        directory: '/storage',
        parentIdentity: { device: 1, inode: 5 },
        ancestors: [{ path: '/', identity: { device: 1, inode: 1 } }],
        directoryIdentity: { device: 4, inode: 5 },
        mountedIdentity: { device: 4, inode: 6 },
        mounts: [{ mountId: 7, device: 8 }],
      },
    };
    const cleaned = { ...before, state: 'cleaned' };
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [{ record: cleaned }]))
      .not.toThrow();
    expect(() => harness.assertRecoveredInvocation(before, before, [{ record: before }]))
      .toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [
      { record: cleaned }, { record: cleaned },
    ])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, {
      ...cleaned,
      storage: { ...before.storage, directoryIdentity: { device: 99, inode: 99 } },
    }, [{ record: cleaned }])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertNoSuccessfulResult({
      result: { structuredContent: { status: 'ok' } },
    })).toThrow(/successful result/);
    expect(() => harness.assertNoSuccessfulResult({
      error: { code: -32603, message: 'interrupted' },
    })).not.toThrow();
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("process.kill(vmmPid, 'SIGKILL')");
    expect(source).toContain('killAwfForRecovery(awf)');
    expect(source).toContain("awf = launchAwf('recovery', 'combined')");
    expect(source).toContain("recoveryTools = await requestMcp");
    expect(source).toContain("open(\"/output/cancel-probe-started\"");
    expect(source).toContain("cancellationController.abort()");
    expect(source).toContain('open("/output/timeout-probe-started"');
    expect(source).toContain("waitForInvocationOutcome(journalRoot, timeoutActive.record, 'timeout')");
    expect(source).toContain("waitForInvocationOutcome(journalRoot, cancellationActive.record, 'cancelled')");
  });

  it('preserves first-run diagnostics and isolates recovery state', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('...artifacts.enclaveArtifactEnvironment');
    expect(source).toContain("path.join(root, 'awf-work-recovery')");
    expect(source).toContain("path.join(root, 'awf-config-recovery.json')");
    expect(source).toContain('captureStderr: true');
    expect(source).toContain('...preRestartLogContents');
    expect(source).toContain('process.exitCode = 1');
    expect(source).toContain('fs.chmodSync(workspace, 0o755)');
    expect(source).toContain("mode: 0o644");
  });

  it('propagates public-client cancellation by closing its in-flight MCP request', async () => {
    let bodyReceived!: () => void;
    let clientDisconnected!: () => void;
    const received = new Promise<void>((resolve) => { bodyReceived = resolve; });
    const disconnected = new Promise<void>((resolve) => { clientDisconnected = resolve; });
    const server = http.createServer((request, response) => {
      request.on('end', bodyReceived);
      request.resume();
      response.on('close', clientDisconnected);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind');
    try {
      const controller = new AbortController();
      const pending = harness.requestMcp(
        `http://127.0.0.1:${address.port}/mcp`,
        'test-gateway-key',
        1,
        'tools/call',
        {},
        controller.signal,
      );
      await received;
      controller.abort();
      await expect(pending).resolves.toBeUndefined();
      await disconnected;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('destroys stalled public MCP requests when their bounded timeout expires', async () => {
    let requestClosed!: () => void;
    const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = http.createServer((request, response) => {
      request.on('close', requestClosed);
      response.on('close', requestClosed);
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind');
    try {
      await expect(harness.requestMcp(
        `http://127.0.0.1:${address.port}/mcp`,
        'test-gateway-key',
        2,
        'tools/call',
        {},
        undefined,
        25,
      )).rejects.toThrow(/request failed/);
      await closed;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('detects synthetic raw-output leaks without echoing the sentinel', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-redaction-'));
    const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_synthetic';
    try {
      const diagnostic = path.join(directory, 'audit.jsonl');
      fs.writeFileSync(diagnostic, '{"category":"success"}\n');
      expect(() => harness.assertNoSentinelLeak([directory], ['safe'], sentinel)).not.toThrow();
      fs.writeFileSync(diagnostic, `{"message":"${sentinel}"}\n`);
      try {
        harness.assertNoSentinelLeak([directory], [], sentinel);
        throw new Error('expected sentinel leak rejection');
      } catch (error) {
        expect((error as Error).message).not.toContain(sentinel);
        expect((error as Error).message).toMatch(/sentinel escaped/);
      }
      expect(() => harness.assertNoSentinelLeak([], [sentinel], sentinel)).toThrow(/captured log/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('scans the opened diagnostic even if its pathname is replaced during inspection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-race-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const displaced = path.join(directory, 'audit.original');
    const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_race';
    const nodeFs = require('fs') as typeof fs;
    fs.writeFileSync(diagnostic, sentinel);
    const originalStat = fs.statSync;
    const originalFstat = fs.fstatSync;
    const replace = () => {
      fs.renameSync(diagnostic, displaced);
      fs.writeFileSync(diagnostic, 'safe replacement');
    };
    const stat = jest.spyOn(nodeFs, 'statSync').mockImplementation((...args) => {
      const result = originalStat(...args);
      if (args[0] === diagnostic) replace();
      return result;
    });
    const fstat = jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      replace();
      return result;
    });
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], sentinel))
        .toThrow(/sentinel escaped/);
    } finally {
      stat.mockRestore();
      fstat.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a diagnostic replaced by a symlink before opening without exposing paths', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-link-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const target = path.join(directory, 'private.original');
    const nodeFs = require('fs') as typeof fs;
    const originalOpen = fs.openSync;
    fs.writeFileSync(diagnostic, 'safe');
    fs.writeFileSync(target, 'private data');
    const open = jest.spyOn(nodeFs, 'openSync').mockImplementation((...args) => {
      if (args[0] === diagnostic) {
        fs.unlinkSync(diagnostic);
        fs.symlinkSync(target, diagnostic);
      }
      return originalOpen(...args);
    });
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], 'sentinel'))
        .toThrow('Could not inspect live enclave diagnostic file');
    } finally {
      open.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds reads of a growing diagnostic and closes the descriptor on rejection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-growth-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const nodeFs = require('fs') as typeof fs;
    const originalFstat = fs.fstatSync;
    fs.writeFileSync(diagnostic, 'safe');
    const fstat = jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      fs.truncateSync(diagnostic, 16 * 1024 * 1024 + 1);
      return result;
    });
    const read = jest.spyOn(nodeFs, 'readSync');
    const close = jest.spyOn(nodeFs, 'closeSync');
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], 'sentinel'))
        .toThrow(/exceeded the scan bound/);
      expect(read).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(fstat.mock.calls[0][0]);
    } finally {
      fstat.mockRestore();
      read.mockRestore();
      close.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gates KVM acceptance separately and fails closed after explicit opt-in', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('run_live_kvm:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('assertGithubHostedRunnerEligibility()');
    expect(workflow).toContain('cloud-hypervisor-enclave-live-smoke.js');
    expect(workflow).toContain("always() && !cancelled() && github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("inputs.run_live_kvm && needs.deterministic.result == 'success'");
    expect(workflow).not.toMatch(/continue-on-error|\|\| true|exit 0/);
  });

  it('invokes both executor tools over the public MCP HTTP route', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('/mcp/awf-enclave');
    expect(source).toContain("name: 'enclave_run_script'");
    expect(source).toContain("name: 'enclave_run_agent'");
    expect(source).toContain("'tools/call'");
    expect(source).not.toContain('executor.sock');
    expect(source).not.toContain('host-executor-client');
  });
});

describe('bounded MCP acceptance check diagnostics', () => {
  const sentinel = 'PRIVATE_TOKEN_CAPABILITY_PAYLOAD_/private/path';
  const canonical = (status = 'error') => ({
    jsonrpc: '2.0', id: 9,
    result: { structuredContent: { status }, content: [{ type: 'text', text: JSON.stringify({ status }) }] },
  });
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('reports missing directories instead of silently treating them as an empty inventory', async () => {
    const context: { check?: Record<string, unknown> } = {};
    await expect(harness.acceptanceCheck(context, 'guest-timeout', 'resource-baseline',
      () => harness.resourceRecords(path.join(root, sentinel, 'missing')))).rejects.toThrow();
    expect(context.check).toMatchObject({ reason: 'resource-inventory-failed', inventory: {
      operation: 'directory-lstat', directory: 'missing', code: 'ENOENT',
    } });
    expect(JSON.stringify(context)).not.toContain(sentinel);
  });

  it.each(['directory-readdir', 'record-open', 'record-fstat', 'record-read', 'record-close',
    'record-validate', 'record-parse', 'record-identity'])(
    'identifies the exact failed inventory operation: %s', async operation => {
      const directory = fs.mkdtempSync(path.join(root, '.resource-reader-'));
      const file = path.join(directory, `${'a'.repeat(32)}-${'b'.repeat(32)}.resources.json`);
      const nodeFs = require('fs') as typeof fs;
      const context: { check?: Record<string, unknown> } = {};
      try {
        fs.writeFileSync(file, operation === 'record-parse' ? sentinel : JSON.stringify({
          state: 'pending', runId: 'a'.repeat(32),
          invocationId: (operation === 'record-identity' ? 'c' : 'b').repeat(32),
        }), { mode: 0o600 });
        if (operation === 'directory-readdir') {
          jest.spyOn(nodeFs, 'readdirSync').mockImplementation(() => {
            throw Object.assign(new Error(sentinel), { code: 'EACCES' });
          });
        }
        const ioError = () => { throw Object.assign(new Error(sentinel), { code: 'EIO' }); };
        if (operation === 'record-open') jest.spyOn(nodeFs, 'openSync').mockImplementation(ioError);
        if (operation === 'record-fstat') jest.spyOn(nodeFs, 'fstatSync').mockImplementation(ioError);
        if (operation === 'record-read') jest.spyOn(nodeFs, 'readSync').mockImplementation(ioError);
        if (operation === 'record-close') {
          const close = fs.closeSync;
          jest.spyOn(nodeFs, 'closeSync').mockImplementation(fd => { close(fd); ioError(); });
        }
        if (operation === 'record-validate') fs.chmodSync(file, 0o644);
        await expect(harness.acceptanceCheck(context, 'guest-timeout', 'resource-baseline',
          () => harness.resourceRecords(directory))).rejects.toThrow();
        expect(context.check).toMatchObject({ reason: 'resource-inventory-failed', inventory: { operation } });
        expect(JSON.stringify(context)).not.toContain(sentinel);
      } finally {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('compares producer directory identity and namespaces without exporting either identity', () => {
    const directory = fs.mkdtempSync(path.join(root, '.resource-producer-'));
    const nodeFs = require('fs') as typeof fs;
    try {
      fs.mkdirSync(path.join(directory, 'diagnostics'), { mode: 0o700 });
      const file = path.join(directory, 'diagnostics', `${'a'.repeat(32)}-${'b'.repeat(32)}.json`);
      fs.writeFileSync(file, JSON.stringify({
        milestones: [], resourcePublication: {
          ownerPid: 123, status: 'published', location: 'default', recordSafe: true,
          directoryIdentity: { device: -1, inode: -1 }, mountNamespace: sentinel,
        },
      }), { mode: 0o600 });
      const originalReadlink = fs.readlinkSync;
      jest.spyOn(nodeFs, 'readlinkSync').mockImplementation((...args) => {
        if (args[0] === '/proc/self/ns/mnt') return 'observer-namespace';
        if (args[0] === '/proc/123/ns/mnt') return 'host-namespace';
        return originalReadlink(...args);
      });
      expect(harness.resourceDiscoveryEvidence(directory, 123, {})).toMatchObject({
        producer: 'published', producerDirectory: 'different',
        mountNamespace: 'different', producerNamespace: 'different', producerActive: true,
      });
      expect(JSON.stringify(harness.resourceDiscoveryEvidence(directory, 123, {}))).not.toContain(sentinel);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['timeout', 'cancelled'] as const)('requires both durable terminal and settled %s evidence', async outcome => {
    const identity = { runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32) };
    let now = 0;
    let reads = 0;
    await harness.waitForInvocationOutcome('/unused', identity, outcome, 1000, {
      now: () => now,
      sleep: async ms => { now += ms; },
      read: () => {
        reads += 1;
        return [
          { runId: identity.runId, state: 'open' },
          { ...identity, state: 'terminal', outcome, resultDigest: hostExecutorResultDigest(outcome, undefined) },
          ...(reads > 1 ? [{ ...identity, state: 'settled',
            resultDigest: hostExecutorResultDigest(outcome, undefined) }] : []),
        ].map(value => JSON.stringify(value)).join('\n');
      },
    });
    expect(reads).toBe(2);
  });

  it.each([
    ['missing-terminal', 'invocation-evidence-timeout'],
    ['other-invocation', 'invocation-evidence-timeout'],
    ['wrong-outcome', 'invocation-outcome-mismatch'],
    ['wrong-digest', 'invocation-outcome-mismatch'],
    ['other-run', 'invocation-evidence-invalid'],
    ['malformed', 'invocation-evidence-invalid'],
    ['read-failed', 'invocation-evidence-invalid'],
  ])('rejects %s evidence instead of accepting an arbitrary canonical error', async (kind, reason) => {
    const identity = { runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32) };
    let now = 0;
    const context: { check?: Record<string, unknown> } = {};
    await expect(harness.acceptanceCheck(context, 'guest-timeout', 'execution-validation',
      () => harness.waitForInvocationOutcome('/unused', identity, 'timeout', 100, {
        now: () => now,
        sleep: async ms => { now += ms; },
        read: () => {
          if (kind === 'read-failed') throw new Error(sentinel);
          if (kind === 'malformed') return sentinel;
          return [
            { runId: kind === 'other-run' ? 'c'.repeat(32) : identity.runId, state: 'open' },
            ...(kind === 'missing-terminal' ? [] : ['terminal', 'settled'].map(state => ({
              ...identity, state,
              invocationId: kind === 'other-invocation' ? 'c'.repeat(32) : identity.invocationId,
              ...(state === 'terminal' ? { outcome: kind === 'wrong-outcome' ? 'executor-failure' : 'timeout' } : {}),
              resultDigest: kind === 'wrong-digest' ? '0'.repeat(64) : hostExecutorResultDigest('timeout', undefined),
            }))),
          ].map(value => JSON.stringify(value)).join('\n');
        },
      }))).rejects.toThrow();
    expect(context.check).toMatchObject({ phase: 'execution-validation', status: 'failed', reason });
    expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
  });

  it('retains early canonical errors even when a request phase itself passes', async () => {
    const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>>;
      observeAdmission?: () => unknown } = {
      observeAdmission: () => ({ broker: { status: 'captured', events: [
        { phase: 'admission', status: 'rejected', reason: 'admissions-closed', secret: sentinel },
      ] } }),
    };
    await harness.acceptanceCheck(context, 'guest-cancellation', 'request', () => ({
      ...canonical(), id: 11,
    }));
    expect(context.check).toMatchObject({
      status: 'passed', response: { structuredStatus: 'error', contentMatches: true },
    });
    await harness.acceptanceCheck(context, 'guest-cancellation', 'cleanup', () => undefined);
    expect(context.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'request', status: 'passed',
        response: expect.objectContaining({ structuredStatus: 'error' }) }),
    ]));
    expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
  });

  it('distinguishes every resource-discovery filter without exposing paths or owner identities', () => {
    const complete = { state: 'pending', owner: { pid: 123 }, storage: { directory: sentinel },
      directoryIdentity: { secret: sentinel }, snapshot: { secret: sentinel } };
    const records = [
      { file: 'existing', record: complete },
      { file: 'terminal', record: { ...complete, state: 'cleaned' } },
      { file: 'wrong-owner', record: { ...complete, owner: { pid: 999 } } },
      { file: 'missing-storage', record: { ...complete, storage: undefined } },
      { file: 'missing-identity', record: { ...complete, directoryIdentity: undefined } },
      { file: 'missing-snapshot', record: { ...complete, snapshot: undefined } },
    ];
    const observation = harness.observeInvocationRecords(records, new Set(['existing']), 123);
    expect(observation).toEqual({ counts: {
      newRecords: 'many', pending: 'many', ownerMatches: 'many', directoryReady: 'many',
      identityReady: 'one', snapshotReady: 'zero', eligible: 'zero',
    }, record: undefined });
    expect(harness.observeInvocationRecords([{ file: 'new', record: complete }], new Set(), 123).record)
      .toEqual({ file: 'new', record: complete });
  });

  it.each(['timeout', 'read-error'])('classifies resource discovery %s without losing request history', async kind => {
    let now = 0;
    const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
    const read = () => {
      if (kind === 'read-error') throw new Error(sentinel);
      return [];
    };
    await expect(harness.acceptanceCheck(context, 'guest-cancellation', 'resource-discovery',
      () => harness.waitForInvocationRecord('/unused', new Set(), 123, 100, {
        now: () => now, sleep: async ms => { now += ms; }, read,
      }))).rejects.toThrow();
    expect(context.check).toMatchObject({
      reason: kind === 'timeout' ? 'resource-discovery-timeout' : 'resource-inventory-failed',
    });
    if (kind === 'timeout') expect(context.check?.resources).toMatchObject({ newRecords: 'zero', eligible: 'zero' });
    expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
  });

  it.each(['agent-enospc', 'script-enospc', 'guest-oom'])(
    'wires every %s phase and preserves the original failure without logging its message', async step => {
      const source = fs.readFileSync(harnessPath, 'utf8');
      for (const phase of ['request', 'result-validation', 'cleanup']) {
        expect(source).toContain(`acceptanceCheck(failureContext, '${step}', '${phase}'`);
        const context: { check?: Record<string, unknown> } = {};
        const error = new Error(sentinel);
        await expect(harness.acceptanceCheck(context, step, phase, () => { throw error; }))
          .rejects.toBe(error);
        expect(context.check).toEqual({ step, phase, status: 'failed', reason: 'operation-failed' });
        await harness.acceptanceCheck(context, step, 'cleanup', () => undefined);
        expect(context.check).toEqual({ step, phase, status: 'failed', reason: 'operation-failed' });
      }
      expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
    },
  );

  it.each(['agent-enospc', 'script-enospc', 'guest-oom'])(
    'distinguishes canonical error and wrong-result outcomes for %s without copying values', async step => {
      for (const [status, reason] of [['error', 'expected-ok-status'], ['ok', 'result-mismatch']]) {
        const context: { check?: Record<string, unknown> } = {};
        const structured = status === 'ok' ? { status, result: sentinel } : { status };
        const response = {
          jsonrpc: '2.0', id: 9, result: {
            structuredContent: structured,
            content: [{ type: 'text', text: JSON.stringify(structured) }],
          },
        };
        await expect(harness.acceptanceCheck(context, step, 'result-validation',
          () => harness.assertExpectedToolResult(response, 9, { enospcObserved: true }, 'resource limit')))
          .rejects.toThrow('guest assertion failed');
        expect(context.check).toMatchObject({
          step, phase: 'result-validation', status: 'failed', reason,
          response: { structuredStatus: status, contentMatches: true },
        });
        expect(JSON.stringify(context)).not.toContain(sentinel);
      }
      const context: { check?: Record<string, unknown> } = {};
      await harness.acceptanceCheck(context, step, 'result-validation', () => {
        const structured = { status: 'ok', result: true };
        harness.assertExpectedToolResult({
          jsonrpc: '2.0', id: 9, result: {
            structuredContent: structured,
            content: [{ type: 'text', text: JSON.stringify(structured) }],
          },
        }, 9, true, 'resource limit');
      });
      expect(context.check).toEqual({ step, phase: 'result-validation', status: 'passed' });
      expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
    },
  );

  it.each([
    ['response-missing', undefined],
    ['jsonrpc-version', { ...canonical(), jsonrpc: sentinel }],
    ['request-id', { ...canonical(), id: sentinel }],
    ['jsonrpc-error', { ...canonical(), error: { message: sentinel, data: sentinel } }],
    ['result-missing', { jsonrpc: '2.0', id: 9 }],
    ['tool-is-error', { ...canonical(), result: { ...canonical().result, isError: true } }],
    ['structured-content', { ...canonical(), result: { structuredContent: { status: sentinel } } }],
    ['structured-fields', {
      ...canonical(), result: { ...canonical().result, structuredContent: { status: 'error', secret: sentinel } },
    }],
    ['content-mismatch', {
      ...canonical(), result: { ...canonical().result, content: [{ type: 'text', text: sentinel }] },
    }],
    ['expected-error-status', {
      ...canonical('ok'), result: {
        structuredContent: { status: 'ok', result: sentinel },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: sentinel }) }],
      },
    }],
  ])('distinguishes %s without logging response values', async (reason, response) => {
    const context: { check?: Record<string, unknown> } = {};
    await expect(harness.acceptanceCheck(context, 'guest-failure', 'result-validation',
      () => harness.assertCanonicalToolError(response, 9))).rejects.toThrow();
    expect(context.check).toMatchObject({
      step: 'guest-failure', phase: 'result-validation', status: 'failed', reason,
    });
    expect(JSON.stringify(context)).not.toContain(sentinel);
    expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
  });

  it('records canonical errors as passed and exposes only response-shape flags on failure', async () => {
    const context: { check?: Record<string, unknown> } = {};
    await harness.acceptanceCheck(context, 'guest-failure', 'result-validation',
      () => harness.assertCanonicalToolError(canonical(), 9));
    expect(context.check).toEqual({ step: 'guest-failure', phase: 'result-validation', status: 'passed' });
    await expect(harness.acceptanceCheck(context, 'guest-failure', 'result-validation',
      () => harness.assertCanonicalToolError({
        ...canonical(), result: { ...canonical().result, isError: true },
      }, 9))).rejects.toThrow();
    expect(context.check?.response).toEqual({
      present: true, jsonrpcValid: true, idMatches: true, rpcError: false, resultPresent: true,
      rpcErrorClass: 'absent', toolIsError: true, structuredPresent: true,
      structuredStatus: 'error', contentMatches: true,
    });
  });

  it.each(['request', 'cleanup', 'resource-discovery', 'marker-wait', 'disconnect-validation'])(
    'names the exact failed %s operation without emitting arbitrary exception text', async phase => {
      const context: { check?: Record<string, unknown> } = {};
      await expect(harness.acceptanceCheck(context, 'guest-cancellation', phase,
        () => { throw new Error(sentinel); })).rejects.toThrow(sentinel);
      expect(context.check).toEqual({
        step: 'guest-cancellation', phase, status: 'failed', reason: 'operation-failed',
      });
      await harness.acceptanceCheck(context, 'guest-cancellation', 'request', () => undefined);
      expect(context.check?.phase).toBe(phase);
      expect(context.check?.status).toBe('failed');
      expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
    },
  );

  it.each<[number, string]>([
    [200, 'invalid-json'], [503, 'http-status'],
  ])('retains HTTP %s and a safe transport reason for non-JSON responses', async (status, reason) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(status);
      response.end(sentinel);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    const context: { check?: Record<string, unknown> } = {};
    try {
      await expect(harness.acceptanceCheck(context, 'guest-failure', 'request',
        () => harness.requestMcp(`http://127.0.0.1:${address.port}`, 'test-only', 9, 'tools/call', {})))
        .rejects.toThrow();
      expect(context.check).toEqual({
        step: 'guest-failure', phase: 'request', status: 'failed', reason, httpStatus: status,
      });
      expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ['oversized', 'response-too-large'],
    ['stalled', 'request-timeout'],
    ['interrupted', 'response-aborted'],
  ])('keeps the %s transport cause even when socket teardown emits another error', async (kind, reason) => {
    const server = http.createServer((request, response) => {
      request.resume();
      if (kind === 'oversized') response.end('x'.repeat(421 * 1024));
      else if (kind === 'interrupted') {
        response.writeHead(200, { 'content-length': '1000' });
        response.write('{');
        setImmediate(() => response.destroy());
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    const context: { check?: Record<string, unknown> } = {};
    try {
      await expect(harness.acceptanceCheck(context, 'guest-timeout', 'request',
        () => harness.requestMcp(`http://127.0.0.1:${address.port}`, 'test-only',
          10, 'tools/call', {}, undefined, 100))).rejects.toThrow();
      expect(context.check).toMatchObject({ phase: 'request', status: 'failed', reason });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('distinguishes an invalid-params RPC rejection and retains HTTP status without copying its message', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end(JSON.stringify({
        jsonrpc: '2.0', id: 9, error: { code: -32602, message: sentinel, data: sentinel },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    const context: { check?: Record<string, unknown> } = {};
    try {
      const result = await harness.requestMcp(
        `http://127.0.0.1:${address.port}`, 'test-only', 9, 'tools/call', {},
      );
      await expect(harness.acceptanceCheck(context, 'guest-failure', 'result-validation',
        () => harness.assertCanonicalToolError(result, 9))).rejects.toThrow();
      expect(context.check).toMatchObject({
        reason: 'jsonrpc-error', httpStatus: 200,
        response: { rpcError: true, rpcErrorClass: 'invalid-params' },
      });
      expect(JSON.stringify(jest.mocked(console.log).mock.calls)).not.toContain(sentinel);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe('profile-aware required container log capture', () => {
  const profiles = ['combined', 'script-only', 'agent-only'];
  const agentProxy = 'awf-enclave-agent-api-proxy';
  const containers = (profile: string) => [
    'awmg-mcpg', 'awf-enclave-mcp-server', 'awf-api-proxy',
    ...(profile === 'script-only' ? [] : [agentProxy]), 'awf-squid',
  ];
  const required = profiles.flatMap(profile => containers(profile).map(container => [profile, container]));
  type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
  let inspect: jest.Mock<CommandResult, [string, string[]]>;
  let isolatedHarness: typeof harness;

  beforeEach(() => {
    inspect = jest.fn((_command: string, args: string[]) => ({
      status: 0, stdout: `stdout:${args[1]}`, stderr: `stderr:${args[1]}`,
    }));
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'), spawnSync: inspect,
    }));
    jest.isolateModules(() => { isolatedHarness = require(harnessPath); });
  });
  afterEach(() => jest.dontMock('child_process'));

  it.each([undefined, ...profiles])('requires the exact container set and both streams for %s', profile => {
    inspect.mockImplementation((_command, args) => ({
      status: profile === 'script-only' && args[1] === agentProxy ? 1 : 0,
      stdout: `stdout:${args[1]}`, stderr: `stderr:${args[1]}`,
    }));
    const expected = containers(profile ?? 'combined');
    expect(isolatedHarness.captureContainerLogs(profile))
      .toEqual(expected.map(container => `stdout:${container}\nstderr:${container}`));
    expect(inspect.mock.calls).toEqual(expected.map(container => [
      'docker', ['logs', container], { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    ]));
  });

  it.each(required)('fails closed when required %s container %s logs fail', (profile, missing) => {
    inspect.mockImplementation((_command, args) => ({
      status: args[1] === missing ? 1 : 0, stdout: '', stderr: 'private docker error',
    }));
    expect(() => isolatedHarness.captureContainerLogs(profile))
      .toThrow('Required live enclave command failed: docker');
  });

  it.each(profiles.flatMap(profile => ['spawn', 'signal', 'buffer'].map(failure => [profile, failure])))(
    'preserves %s log-capture %s failures', (profile, failure) => {
      inspect.mockReturnValue({
        status: null, stdout: 'partial stdout', stderr: 'partial stderr',
        ...(failure === 'signal' ? {} : {
          error: Object.assign(new Error('private spawn error'), {
            code: failure === 'buffer' ? 'ENOBUFS' : 'ENOENT',
          }),
        }),
      });
      expect(() => isolatedHarness.captureContainerLogs(profile))
        .toThrow('Required live enclave command failed: docker');
    },
  );

  it.each(required.flatMap(([profile, container]) => ['stdout', 'stderr'].map(stream => [profile, container, stream])))(
    'rejects sentinel leaks in %s container %s %s', (profile, container, stream) => {
      const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_synthetic';
      inspect.mockImplementation((_command, args) => ({
        status: 0,
        stdout: args[1] === container && stream === 'stdout' ? sentinel : 'safe stdout',
        stderr: args[1] === container && stream === 'stderr' ? sentinel : 'safe stderr',
      }));
      const logs = isolatedHarness.captureContainerLogs(profile);
      expect(() => isolatedHarness.assertNoSentinelLeak([], logs, sentinel)).toThrow(/captured log/);
    },
  );
});

describe('single-executor profile acceptance diagnostics', () => {
  const sentinel = 'PRIVATE_PROFILE_PAYLOAD_/private/path';
  const phases = [
    'stop-marker', 'host-stop', 'host-stop-validation', 'stop-marker-remove',
    'profile-config', 'profile-launch', 'broker-readiness', 'gateway-readiness', 'primary-readiness',
    'initialize', 'initialize-validation', 'tools-list', 'tools-validation',
    'request', 'result-validation', 'cleanup', 'stdout-read', 'stderr-read', 'container-logs', 'output-redaction',
  ];
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['script-only', 'agent-only'])('wires each %s operation through the shared checkpoint guard', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    const block = source.slice(source.indexOf("for (const profile of ['script-only', 'agent-only'])"),
      source.indexOf('acceptancePassed = true;'));
    for (const phase of phases) expect(block).toContain(`acceptanceCheck(failureContext, profile, '${phase}'`);
    expect(block.match(/acceptanceCheck\(failureContext, profile, 'request'/g)).toHaveLength(2);
    expect(block.match(/acceptanceCheck\(failureContext, profile, 'result-validation'/g)).toHaveLength(2);
    expect(block.indexOf("'initialize-validation'")).toBeGreaterThan(block.indexOf("'initialize'"));
    expect(block.indexOf("'tools-validation'")).toBeGreaterThan(block.indexOf("'tools-list'"));
    expect(block.indexOf("'result-validation'")).toBeGreaterThan(block.indexOf("'request'"));
    expect(block.indexOf("'output-redaction'")).toBeGreaterThan(block.indexOf("'cleanup'"));
    expect(block).toContain('() => captureContainerLogs(profile)');
    expect(block.indexOf("'output-redaction'")).toBeGreaterThan(block.indexOf("'container-logs'"));
    expect(block).toContain('[profileStdout, profileStderr, ...profileContainerLogs]');
  });

  it.each(['script-only', 'agent-only'].flatMap(profile => phases.map(phase => [profile, phase])))(
    'preserves the exact %s/%s failure and suppresses raw details', async (profile, phase) => {
      const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
      const failure = Object.assign(new Error(sentinel), { code: 'EIO' });
      await expect(harness.acceptanceCheck(context, profile, phase, () => { throw failure; })).rejects.toBe(failure);
      await harness.acceptanceCheck(context, profile, 'cleanup', () => undefined);
      expect(context.check).toEqual({ step: profile, phase, status: 'failed', reason: 'operation-failed', code: 'EIO' });
      expect(context.checks?.slice(-1)[0]).toEqual({ step: profile, phase: 'cleanup', status: 'passed' });
      expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
    },
  );

  it.each([['script-only', 14], ['agent-only', 17]] as const)(
    'retains response shape and fixed server/tool flags for %s', async (profile, id) => {
      const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
      const response = { jsonrpc: '2.0', id, result: { serverInfo: { name: 'awmg-awf-enclave', private: sentinel } } };
      await harness.acceptanceCheck(context, profile, 'initialize', () => response);
      expect(context.check).toMatchObject({ response: { present: true, jsonrpcValid: true, idMatches: true } });
      await harness.acceptanceCheck(context, profile, 'initialize-validation',
        () => harness.assertProfileInitialize(response, id));
      expect(context.check).toMatchObject({ profile: { serverMatches: true } });
      const tools = { jsonrpc: '2.0', id: id + 1, result: {
        tools: [{ name: profile === 'script-only' ? 'enclave_run_script' : 'enclave_run_agent', description: sentinel }],
      } };
      await harness.acceptanceCheck(context, profile, 'tools-list', () => tools);
      expect(context.check).toMatchObject({ response: { idMatches: true } });
      await harness.acceptanceCheck(context, profile, 'tools-validation',
        () => harness.assertProfileTools(tools, profile, id + 1));
      expect(context.check).toMatchObject({ profile: {
        toolsArray: true, scriptPresent: profile === 'script-only', agentPresent: profile === 'agent-only',
        toolsMatch: true,
      } });
      const result = { jsonrpc: '2.0', id: id + 2, result: {
        structuredContent: { status: 'ok', result: sentinel },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: sentinel }) }],
      } };
      await harness.acceptanceCheck(context, profile, 'request', () => result);
      expect(context.check).toMatchObject({ response: {
        idMatches: true, contentMatches: true, structuredStatus: 'ok',
      } });
      expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
    },
  );

  it.each(['script-only', 'agent-only'])('names a wrong broker server for %s without exporting its name', async profile => {
    const context: { check?: Record<string, unknown> } = {};
    const response = { jsonrpc: '2.0', id: 14, result: { serverInfo: { name: sentinel } } };
    await expect(harness.acceptanceCheck(context, profile, 'initialize-validation',
      () => harness.assertProfileInitialize(response, 14))).rejects.toThrow();
    expect(context.check).toMatchObject({
      reason: 'profile-initialize-invalid', profile: { serverMatches: false }, response: { idMatches: true },
    });
    expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
  });

  it.each(['both', 'missing', 'unknown', 'duplicate', 'malformed'])(
    'diagnoses %s tool declarations without exporting untrusted names', async kind => {
      const names = kind === 'both' ? ['enclave_run_script', 'enclave_run_agent']
        : kind === 'missing' ? [] : kind === 'duplicate' ? ['enclave_run_script', 'enclave_run_script'] : [sentinel];
      const response = { jsonrpc: '2.0', id: 15, result: {
        tools: kind === 'malformed' ? sentinel : names.map(name => ({ name, description: sentinel })),
      } };
      const context: { check?: Record<string, unknown> } = {};
      await expect(harness.acceptanceCheck(context, 'script-only', 'tools-validation',
        () => harness.assertProfileTools(response, 'script-only', 15))).rejects.toThrow();
      expect(context.check).toMatchObject({
        reason: 'profile-tools-invalid', profile: { toolsMatch: false, toolsArray: kind !== 'malformed' },
        response: { idMatches: true },
      });
      expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
    },
  );

  it('retains a canonical result mismatch without exporting either result', async () => {
    const context: { check?: Record<string, unknown> } = {};
    const result = { status: 'ok', result: sentinel };
    const response = { jsonrpc: '2.0', id: 16, result: {
      structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }],
    } };
    await expect(harness.acceptanceCheck(context, 'script-only', 'result-validation',
      () => harness.assertExpectedToolResult(response, 16, true, 'script-only profile'))).rejects.toThrow();
    expect(context.check).toMatchObject({ reason: 'result-mismatch', response: {
      idMatches: true, structuredStatus: 'ok', contentMatches: true,
    } });
    expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
  });
});

describe('guarded crash-recovery diagnostics', () => {
  const sentinel = 'PRIVATE_CRASH_RECOVERY_PAYLOAD_/private/path';
  const phases = [
    'resource-baseline', 'request-start', 'resource-discovery', 'marker-wait', 'resource-refresh', 'vmm-discovery',
    'vmm-kill', 'host-kill', 'stdout-read', 'stderr-read', 'container-logs', 'compose-stop',
    'recovery-config', 'recovery-launch', 'broker-readiness', 'gateway-readiness',
    'primary-readiness', 'tools-list', 'resource-read', 'recovery-validation', 'interrupted-response', 'cleanup',
  ];
  function crashRecord() {
    return {
      runId: 'a'.repeat(32), invocationId: 'b'.repeat(24), state: 'cleaned',
      owner: { pid: process.pid, startTime: '12345' }, mountPending: false, snapshotPending: false,
      directory: sentinel, directoryIdentity: { device: 1, inode: 2 },
      ancestors: [{ path: sentinel, identity: { device: 1, inode: 3 } }],
      mount: { mountId: 1, device: 2 },
      snapshot: { path: sentinel, identity: { device: 3, inode: 4 } },
      storage: {
        directory: sentinel, parentIdentity: { device: 1, inode: 5 },
        ancestors: [{ path: sentinel, identity: { device: 1, inode: 1 } }],
        directoryIdentity: { device: 4, inode: 5 }, mountedIdentity: { device: 4, inode: 6 },
        mounts: [{ mountId: 7, device: 8, mountPoint: sentinel }],
      },
    };
  }
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('refreshes the complete journal only after the guest marker and before killing the VMM', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    const crash = source.slice(source.indexOf('const crashProbe ='), source.indexOf(
      'failureContext.stage = FAILURE_STAGES.OUTPUT_REDACTION;',
    ));
    const marker = crash.indexOf("'marker-wait'");
    const refresh = crash.indexOf("'resource-refresh'");
    const kill = crash.indexOf("'vmm-kill'");
    expect(marker).toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(marker);
    expect(kill).toBeGreaterThan(refresh);
    expect(crash).toContain('readCrashRecoveryBaseline(journalRoot, active, awf.pid)');
    expect(crash).toContain('assertRecoveredInvocation(crashBaseline.record, recovered.after, recovered.records)');
    expect(crash).not.toContain('assertRecoveredInvocation(active.record,');
  });

  it.each(['unchanged', 'appended'])('uses the protected post-marker baseline with %s mounts', async kind => {
    const directory = fs.mkdtempSync(path.join(root, '.crash-baseline-'));
    const before = { ...crashRecord(), state: 'pending' };
    if (kind === 'appended') before.storage.mounts = [];
    const current = { ...crashRecord(), state: 'pending' };
    const file = path.join(directory, `${current.runId}-${current.invocationId}.resources.json`);
    const context: { check?: Record<string, unknown> } = {};
    try {
      fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 });
      const refreshed = await harness.acceptanceCheck(context, 'crash-recovery', 'resource-refresh',
        () => harness.readCrashRecoveryBaseline(directory, { file, record: before }, process.pid));
      expect(refreshed.record).toEqual(current);
      expect(Object.values(refreshed.baseline)).toEqual(Array(7).fill(true));
      expect(context.check).toMatchObject({ status: 'passed', baseline: refreshed.baseline,
        inventory: { operation: 'complete' } });
      const cleaned = { ...current, state: 'cleaned' };
      expect(() => harness.assertRecoveredInvocation(refreshed.record, cleaned, [{ record: cleaned }])).not.toThrow();
      if (kind === 'appended') {
        expect(() => harness.assertRecoveredInvocation(before, cleaned, [{ record: cleaned }])).toThrow();
      }
      expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['owner', 'owner-identity', 'directory', 'snapshot', 'removed-mount', 'changed-mount',
    'pending-storage', 'pending-snapshot', 'pending-invocation', 'missing-snapshot-mount', 'cleaned'])(
    'rejects an unsafe post-marker baseline: %s', async kind => {
      const directory = fs.mkdtempSync(path.join(root, '.crash-baseline-'));
      const before = { ...crashRecord(), state: 'pending' };
      const current = { ...crashRecord(), state: 'pending' };
      const file = path.join(directory, `${current.runId}-${current.invocationId}.resources.json`);
      const context: { check?: Record<string, unknown> } = {};
      if (kind === 'owner') current.owner.pid += 1;
      if (kind === 'owner-identity') current.owner.startTime = 'changed';
      if (kind === 'directory') current.directoryIdentity.inode += 1;
      if (kind === 'snapshot') current.snapshot.identity.inode += 1;
      if (kind === 'removed-mount') current.storage.mounts = [];
      if (kind === 'changed-mount') current.storage.mounts[0].mountId += 1;
      if (kind === 'pending-storage') Object.assign(current.storage, { pending: sentinel });
      if (kind === 'pending-snapshot') current.snapshotPending = true;
      if (kind === 'pending-invocation') current.mountPending = true;
      if (kind === 'missing-snapshot-mount') {
        before.storage.mounts = [];
        current.storage.mounts = [];
      }
      if (kind === 'cleaned') current.state = 'cleaned';
      try {
        fs.writeFileSync(file, JSON.stringify(current), { mode: 0o600 });
        await expect(harness.acceptanceCheck(context, 'crash-recovery', 'resource-refresh',
          () => harness.readCrashRecoveryBaseline(directory, { file, record: before }, process.pid))).rejects.toThrow();
        expect(context.check).toMatchObject({
          status: 'failed', reason: 'crash-baseline-invalid', inventory: { operation: 'complete' },
        });
        expect(Object.values(context.check?.baseline || {}).some(value => value === false)).toBe(true);
        expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(phases)('retains the exact failed %s phase and errno through independent cleanup', async phase => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain(`acceptanceCheck(failureContext, 'crash-recovery', '${phase}'`);
    const error = Object.assign(new Error(sentinel), { code: 'EIO' });
    const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
    const order: string[] = [];
    let retained = false;
    await expect(harness.withCrashRecoveryCleanup(context,
      () => harness.acceptanceCheck(context, 'crash-recovery', phase, () => { throw error; }),
      ['request-abort', 'host-cleanup', 'compose-cleanup'].map(cleanup => ({
        phase: cleanup, action: () => {
          order.push(cleanup);
          if (cleanup !== 'compose-cleanup') throw new Error(sentinel);
        },
      })),
      () => { retained = true; })).rejects.toBe(error);
    expect(order).toEqual(['request-abort', 'host-cleanup', 'compose-cleanup']);
    expect(retained).toBe(true);
    expect(context.check).toEqual({
      step: 'crash-recovery', phase, status: 'failed', reason: 'operation-failed', code: 'EIO',
    });
    expect(context.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'host-cleanup', status: 'failed' }),
      expect.objectContaining({ phase: 'compose-cleanup', status: 'passed' }),
    ]));
    expect(JSON.stringify([context, jest.mocked(console.log).mock.calls, jest.mocked(console.error).mock.calls]))
      .not.toContain(sentinel);
  });

  it('does not run failure cleanup after successful recovery', async () => {
    const cleanup = jest.fn();
    const preserve = jest.fn();
    await expect(harness.withCrashRecoveryCleanup({}, async () => true,
      [{ phase: 'host-cleanup', action: cleanup }], preserve)).resolves.toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
  });

  it('does not replace the primary failure when admission evidence collection throws', async () => {
    const error = new Error(sentinel);
    const context = { observeAdmission: () => { throw new Error(sentinel); } };
    await expect(harness.acceptanceCheck(context, 'crash-recovery', 'tools-list',
      () => { throw error; })).rejects.toBe(error);
    expect(context).toMatchObject({
      check: { step: 'crash-recovery', phase: 'tools-list', status: 'failed', reason: 'operation-failed' },
      admissionEvidence: { broker: { status: 'read-failed' }, hostControl: { status: 'read-failed' } },
    });
    expect(console.error).toHaveBeenCalledWith(
      'Could not capture enclave admission evidence; raw error details were suppressed.',
    );
    expect(JSON.stringify([context, jest.mocked(console.error).mock.calls])).not.toContain(sentinel);
  });

  it('still fails acceptance when required admission evidence cannot be captured after a request', async () => {
    const context = { observeAdmission: () => { throw new Error(sentinel); } };
    await expect(harness.acceptanceCheck(context, 'guest-failure', 'request', () => undefined)).rejects.toThrow();
    expect(context).toMatchObject({ check: {
      phase: 'request', status: 'failed', reason: 'admission-evidence-failed',
    } });
  });

  const mismatches: Array<[string, (record: ReturnType<typeof crashRecord>) => void]> = [
    ['cleaned', record => { record.state = 'pending'; }],
    ['runMatches', record => { record.runId = sentinel; }],
    ['invocationMatches', record => { record.invocationId = sentinel; }],
    ['directoryMatches', record => { record.directory = '/different'; }],
    ['directoryIdentityMatches', record => { record.directoryIdentity.inode = 99; }],
    ['ancestorsMatch', record => { record.ancestors[0].identity.inode = 99; }],
    ['mountMatches', record => { record.mount.mountId = 99; }],
    ['snapshotMatches', record => { record.snapshot.identity.inode = 99; }],
    ['storageDirectoryMatches', record => { record.storage.directory = '/different'; }],
    ['storageParentIdentityMatches', record => { record.storage.parentIdentity.inode = 99; }],
    ['storageAncestorsMatch', record => { record.storage.ancestors[0].identity.inode = 99; }],
    ['storageDirectoryIdentityMatches', record => { record.storage.directoryIdentity.inode = 99; }],
    ['storageMountedIdentityMatches', record => { record.storage.mountedIdentity.inode = 99; }],
    ['storageMountsMatch', record => { record.storage.mounts[0].mountId = 99; }],
  ];
  it.each(mismatches)('names the failed recovery invariant %s without exporting identities', async (flag, mutate) => {
    const before = crashRecord();
    const after = crashRecord();
    mutate(after);
    const context: { check?: Record<string, unknown> } = {};
    await expect(harness.acceptanceCheck(context, 'crash-recovery', 'recovery-validation',
      () => harness.assertRecoveredInvocation(before, after, [{ record: after }]))).rejects.toThrow();
    expect(context.check).toMatchObject({
      reason: 'recovery-validation-failed', recovery: { [flag]: false },
    });
    expect(Object.values(context.check?.recovery || {}).every(value => typeof value === 'boolean')).toBe(true);
    expect(JSON.stringify([context, jest.mocked(console.log).mock.calls])).not.toContain(sentinel);
  });

  it.each(['directoryIdentityPresent', 'storageDirectoryIdentityPresent',
    'storageMountedIdentityPresent', 'snapshotPresent', 'uniqueRecord'])(
    'diagnoses the missing recovery prerequisite %s', async flag => {
      const before: Parameters<typeof harness.assertRecoveredInvocation>[0] = crashRecord();
      const after = crashRecord();
      const records = [{ record: after }];
      if (flag === 'directoryIdentityPresent') before.directoryIdentity = undefined;
      if (flag === 'storageDirectoryIdentityPresent') before.storage.directoryIdentity = undefined;
      if (flag === 'storageMountedIdentityPresent') before.storage.mountedIdentity = undefined;
      if (flag === 'snapshotPresent') before.snapshot = undefined;
      if (flag === 'uniqueRecord') records.push({ record: after });
      const context: { check?: Record<string, unknown> } = {};
      await expect(harness.acceptanceCheck(context, 'crash-recovery', 'recovery-validation',
        () => harness.assertRecoveredInvocation(before, after, records))).rejects.toThrow();
      expect(context.check).toMatchObject({ recovery: { [flag]: false } });
    },
  );

  it('retains successful invariant comparisons and distinguishes interrupted success from disconnect', async () => {
    const before = crashRecord();
    const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
    await harness.acceptanceCheck(context, 'crash-recovery', 'recovery-validation',
      () => harness.assertRecoveredInvocation(before, before, [{ record: before }]));
    expect(Object.values(context.check?.recovery || {})).toEqual(Array(19).fill(true));
    await harness.acceptanceCheck(context, 'crash-recovery', 'interrupted-response', () => ({ disconnected: true }));
    expect(context.check).toMatchObject({ interrupted: 'disconnected', status: 'passed' });
    const response = { jsonrpc: '2.0', id: 12, result: { structuredContent: { status: 'ok', result: sentinel } } };
    await expect(harness.acceptanceCheck(context, 'crash-recovery', 'interrupted-response',
      () => harness.assertNoSuccessfulResult(response))).rejects.toThrow();
    expect(context.check).toMatchObject({
      reason: 'interrupted-success', response: { structuredStatus: 'ok', idMatches: true },
    });
    expect(JSON.stringify(context)).not.toContain(sentinel);
  });

  it.each(['valid', 'missing', 'malformed', 'symlink', 'oversized'])(
    'reads recovery records through the bounded protected inventory: %s', async kind => {
      const directory = fs.mkdtempSync(path.join(root, '.crash-record-'));
      const record = crashRecord();
      const file = path.join(directory, `${record.runId}-${record.invocationId}.resources.json`);
      const context: { check?: Record<string, unknown> } = {};
      try {
        if (kind === 'symlink') fs.symlinkSync(path.join(directory, sentinel), file);
        else if (kind !== 'missing') fs.writeFileSync(file, kind === 'malformed' ? sentinel
          : kind === 'oversized' ? sentinel.repeat(8192) : JSON.stringify(record), { mode: 0o600 });
        const read = () => harness.acceptanceCheck(context, 'crash-recovery', 'resource-read',
          () => harness.readRecoveredInvocation(directory, file));
        if (kind === 'valid') {
          await expect(read()).resolves.toMatchObject({ after: record, records: [{ file, record }] });
          expect(context.check).toMatchObject({ inventory: { operation: 'complete' }, status: 'passed' });
        } else {
          await expect(read()).rejects.toThrow();
          expect(context.check).toMatchObject({
            reason: ['missing', 'symlink'].includes(kind) ? 'recovery-record-missing' : 'resource-inventory-failed',
          });
          if (kind === 'malformed') expect(context.check).toMatchObject({ inventory: { operation: 'record-parse' } });
          if (kind === 'oversized') expect(context.check).toMatchObject({ inventory: { operation: 'record-validate' } });
        }
        expect(JSON.stringify(context)).not.toContain(sentinel);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('crash-recovery host termination races', () => {
  let child: EventEmitter & StartupChild & { kill: jest.Mock<boolean, [string]> };
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, kill: jest.fn((signal: string) => signal === 'SIGKILL'),
    });
  });
  afterEach(() => {
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('registers its exit listener before killing the host and clears its timer', async () => {
    child.kill.mockImplementation(() => { child.emit('exit', null, 'SIGKILL'); return true; });
    await expect(harness.killAwfForRecovery(child)).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips shutdown timers for a host that already exited', async () => {
    child.exitCode = 0;
    await expect(harness.stopAwf(child, 100, 100)).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('still cleans a production-tracked host after a signal-delivery error', async () => {
    const tracked = harness.trackAwfChild(Object.assign(child, { pid: 123 }));
    const context: { check?: Record<string, unknown>; checks?: Array<Record<string, unknown>> } = {};
    child.kill.mockImplementationOnce(() => {
      child.emit('error', new Error('PRIVATE_HOST_KILL_DETAIL'));
      return false;
    }).mockImplementationOnce(() => {
      child.emit('exit', 0);
      return true;
    });
    try {
      const error = await harness.acceptanceCheck(context, 'crash-recovery', 'host-kill',
        () => harness.killAwfForRecovery(tracked)).catch(failure => failure);
      expect(error).toBeInstanceOf(Error);
      expect(harness.failedSpawns.has(tracked)).toBe(false);
      const preserve = jest.fn();
      const pending = harness.withCrashRecoveryCleanup(context, async () => { throw error; }, [
        { phase: 'host-cleanup', action: async () => {
          if (tracked.exitCode === null && tracked.signalCode === null && !harness.failedSpawns.has(tracked)) {
            await harness.stopAwf(tracked, 100, 100);
          }
        } },
      ], preserve);
      const rejected = expect(pending).rejects.toBe(error);
      await jest.advanceTimersByTimeAsync(100);
      await rejected;
      expect(child.kill.mock.calls).toEqual([['SIGKILL'], ['SIGTERM']]);
      expect(context.check).toMatchObject({ phase: 'host-kill', status: 'failed', reason: 'host-kill-failed' });
      expect(context.checks).toEqual(expect.arrayContaining([
        { step: 'crash-recovery', phase: 'host-cleanup', status: 'passed' },
      ]));
      expect(preserve).not.toHaveBeenCalled();
      expect(child.listenerCount('error')).toBe(1);
    } finally {
      child.removeAllListeners('error');
    }
  });

  it.each(['SIGTERM', 'SIGKILL', 'error-event'])(
    'contains a cleanup %s failure inside the awaited operation', async failure => {
      const context: { check?: Record<string, unknown> } = {};
      const error = Object.assign(new Error('PRIVATE_HOST_KILL_DETAIL'), { code: 'ESRCH' });
      child.kill.mockImplementation(signal => {
        if (failure === 'error-event') child.emit('error', error);
        else if (signal === failure) throw error;
        return true;
      });
      const pending = harness.acceptanceCheck(context, 'crash-recovery', 'host-cleanup',
        () => harness.stopAwf(child, 100, 100));
      const rejected = expect(pending).rejects.toThrow();
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
      await rejected;
      expect(context.check).toMatchObject({
        phase: 'host-cleanup', status: 'failed', reason: 'host-kill-failed', code: 'ESRCH',
      });
      expect(JSON.stringify(context)).not.toContain('PRIVATE_HOST_KILL_DETAIL');
    },
  );

  it.each(['already-exited', 'false', 'throw', 'error-event', 'timeout'])(
    'handles %s as a finite failure instead of an uncaught error or leaked timer', async kind => {
      const context: { check?: Record<string, unknown> } = {};
      if (kind === 'already-exited') child.exitCode = 0;
      if (kind === 'false') child.kill.mockReturnValue(false);
      if (kind === 'throw') child.kill.mockImplementation(() => {
        throw Object.assign(new Error('PRIVATE_HOST_KILL_DETAIL'), { code: 'ESRCH' });
      });
      if (kind === 'error-event') child.kill.mockImplementation(() => {
        child.emit('error', new Error('PRIVATE_HOST_KILL_DETAIL')); return true;
      });
      const pending = harness.acceptanceCheck(context, 'crash-recovery', 'host-kill',
        () => harness.killAwfForRecovery(child, 100));
      const rejected = expect(pending).rejects.toThrow();
      if (kind === 'timeout') jest.advanceTimersByTime(100);
      await rejected;
      expect(context.check).toMatchObject({
        phase: 'host-kill', status: 'failed',
        reason: kind === 'already-exited' ? 'host-already-exited'
          : kind === 'timeout' ? 'host-exit-timeout' : 'host-kill-failed',
      });
      if (kind === 'throw') expect(context.check?.code).toBe('ESRCH');
      if (kind === 'already-exited') expect(child.kill).not.toHaveBeenCalled();
      expect(JSON.stringify(context)).not.toContain('PRIVATE_HOST_KILL_DETAIL');
    },
  );
});

describe('sanitized live acceptance failure reporting', () => {
  const sentinel = 'AWF_PASSWD_SENTINEL_sensitive-user-record';
  const expected = (stage: string) => `Live enclave acceptance failed during ${stage}; `
    + 'raw error details were suppressed. Review AWF_ENCLAVE_ACCEPTANCE_CHECK, AWF_HOST_STARTUP_DIAGNOSTIC and AWF_PRIMARY_VM_READINESS records above.';

  afterEach(() => jest.restoreAllMocks());

  it.each([
    new Error(sentinel),
    Object.assign(new Error('outer failure'), { cause: new Error(sentinel) }),
    { message: sentinel },
    sentinel,
  ])('does not emit raw error variants and preserves failure status', (failure) => {
    const originalExitCode = process.exitCode;
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      harness.reportFailure(failure, 'GH_TOKEN/GITHUB_TOKEN prerequisites');
      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(expected('GH_TOKEN/GITHUB_TOKEN prerequisites'));
      expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it.each(['agent enclave checks', 'primary VM readiness'])('identifies %s with its fixed stage label', (stage) => {
    const originalExitCode = process.exitCode;
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      harness.reportFailure(new Error(sentinel), stage);
      expect(output).toHaveBeenCalledWith(expected(stage));
      expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  describe('shared primary VM readiness gate', () => {
    const sentinel = 'AWF_PRIVATE_PRIMARY_OUTPUT_SENTINEL';
    const primary: VmResidue = {
      namespaces: ['awfvm-0123456789ab'],
      processes: [{ pid: '123', startTime: '456' }],
      cgroups: [{ name: 'primary', device: 1, inode: 789 }],
    };
    const empty: VmResidue = { namespaces: [], processes: [], cgroups: [] };
    let directory: string;
    let child: StartupChild & { pid: number };
    let progress: PrimaryProgress | undefined;
    let clock: number;
    let dependencies: {
      readProgress: jest.Mock<PrimaryProgress | undefined, []>;
      capture: jest.Mock<VmResidue, []>;
      verify: jest.Mock<Promise<string>, []>;
      now: () => number;
      sleep: jest.Mock<Promise<void>, [number]>;
    };
    let output: jest.SpyInstance;
    const wait = () => harness.waitForPrimaryVmReadiness(child, 1000, {
      startupErrorFile: path.join(directory, 'awf-startup-error.json'),
    }, dependencies);
    const diagnostic = () => {
      expect(output).toHaveBeenCalledTimes(1);
      const line = String(output.mock.calls[0][0]);
      expect(line.startsWith('AWF_PRIMARY_VM_READINESS ')).toBe(true);
      expect(Buffer.byteLength(line)).toBeLessThan(1024);
      expect(line).not.toContain(sentinel);
      expect(line).not.toContain(directory);
      return JSON.parse(line.slice('AWF_PRIMARY_VM_READINESS '.length));
    };
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-primary-readiness-'));
      child = { pid: process.pid, exitCode: null, signalCode: null };
      progress = {
        schemaVersion: 1, ownerPid: child.pid, stage: 'guest-boot', state: 'starting',
        bootAttempt: 1, runId: 'primary',
      };
      clock = 0;
      dependencies = {
        readProgress: jest.fn(() => progress),
        capture: jest.fn(() => primary),
        verify: jest.fn(async () => 'verified'),
        now: () => clock,
        sleep: jest.fn(async (ms: number) => { clock += ms; }),
      };
      output = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      fs.rmSync(directory, { recursive: true, force: true });
      jest.restoreAllMocks();
    });

    it('does not capture or execute until delayed guest readiness, even after the gateway is ready', async () => {
      dependencies.sleep.mockImplementation(async (ms) => {
        clock += ms;
        expect(dependencies.capture).not.toHaveBeenCalled();
        expect(dependencies.verify).not.toHaveBeenCalled();
        progress = { ...progress!, stage: 'ready', state: 'ready' };
      });
      await expect(wait()).resolves.toEqual(primary);
      expect(clock).toBe(250);
      expect(dependencies.verify).toHaveBeenCalledTimes(1);
      expect(output).not.toHaveBeenCalled();
    });

    it('times out gateway-only readiness with counts but no claimed primary identity', async () => {
      await expect(wait()).rejects.toThrow('Primary VM readiness failed: timeout');
      expect(clock).toBe(1000);
      expect(dependencies.capture).toHaveBeenLastCalledWith(11_000);
      expect(dependencies.verify).not.toHaveBeenCalled();
      expect(diagnostic()).toMatchObject({
        stage: 'primary-vm-readiness', reason: 'timeout',
        primary: { stage: 'guest-boot', state: 'starting' },
        resources: { inspection: 'complete', processes: 1, identity: 'not-attempted' },
        child: { status: 'running', exitCode: null, signal: null },
      });
    });

    it('waits for incomplete resource and journal publication without accepting either', async () => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      dependencies.capture.mockReturnValueOnce(empty);
      dependencies.verify.mockResolvedValueOnce('pending');
      await expect(wait()).resolves.toEqual(primary);
      expect(clock).toBe(500);
      expect(dependencies.capture).toHaveBeenCalledTimes(3);
      expect(dependencies.verify).toHaveBeenCalledTimes(2);
    });

    it('does not reuse a ready publication while its replacement is incomplete', async () => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      dependencies.capture.mockReturnValue(empty);
      dependencies.readProgress.mockReturnValueOnce(progress).mockReturnValue(undefined);
      await expect(wait()).rejects.toThrow(/timeout/);
      expect(dependencies.verify).not.toHaveBeenCalled();
      expect(dependencies.capture).toHaveBeenCalledTimes(1);
      expect(diagnostic().reason).toBe('timeout');
    });

    it('reports terminal primary startup failure before inspecting or waiting for cleanup', async () => {
      progress = { ...progress!, state: 'failed' };
      await expect(wait()).rejects.toThrow(/startup-failure/);
      expect(clock).toBe(0);
      expect(diagnostic()).toMatchObject({ reason: 'startup-failure', primary: { state: 'failed' } });
    });

    it.each(['spawn-failure', 'exit', 'signal'])('detects an actual child %s promptly', async (reason) => {
      const actual = harness.trackAwfChild(reason === 'spawn-failure'
        ? spawn(path.join(directory, sentinel))
        : spawn(process.execPath, ['-e', reason === 'exit'
          ? 'process.exit(9)' : 'process.kill(process.pid, "SIGTERM")']));
      await new Promise<void>((resolve) => actual.once('close', () => resolve()));
      await expect(harness.waitForPrimaryVmReadiness(actual, 1000, {
        startupErrorFile: path.join(directory, 'awf-startup-error.json'),
      }, dependencies)).rejects.toThrow(reason);
      expect(clock).toBe(0);
      expect(diagnostic()).toMatchObject({
        reason, child: {
          exitCode: reason === 'exit' ? 9 : null,
          signal: reason === 'signal' ? 'SIGTERM' : null,
        },
      });
    });

    it('rejects a child termination racing successful resource verification', async () => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      dependencies.verify.mockImplementation(async () => {
        child.signalCode = 'SIGKILL';
        return 'verified';
      });
      await expect(wait()).rejects.toThrow(/signal/);
      expect(diagnostic().child.signal).toBe('SIGKILL');
    });

    it('uses the final readiness publication when the child exits between polls', async () => {
      dependencies.sleep.mockImplementationOnce(async (ms) => {
        clock += ms;
        child.exitCode = 9;
        progress = { ...progress!, stage: 'guest-boot', state: 'failed' };
      });
      await expect(wait()).rejects.toThrow(/exit/);
      expect(diagnostic()).toMatchObject({
        primary: { stage: 'guest-boot', state: 'failed' },
        child: { status: 'exited', exitCode: 9 },
      });
    });

    it.each([
      ['mismatch', 'exit', 'exitCode'],
      ['rejection', 'signal', 'signalCode'],
    ])('prioritizes child termination over identity %s', async (verification, reason, status) => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      dependencies.verify.mockImplementation(async () => {
        if (status === 'exitCode') child.exitCode = 9;
        else child.signalCode = 'SIGTERM';
        if (verification === 'rejection') throw new Error(sentinel);
        return 'mismatch';
      });
      await expect(wait()).rejects.toThrow(new RegExp(reason));
      expect(diagnostic()).toMatchObject({
        reason,
        child: {
          status: reason === 'exit' ? 'exited' : 'signalled',
          exitCode: reason === 'exit' ? 9 : null,
          signal: reason === 'signal' ? 'SIGTERM' : null,
        },
      });
    });

    it.each(['progress', 'resources', 'identity'])('sanitizes %s inspection failures', async (part) => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      if (part === 'progress') dependencies.readProgress.mockImplementation(() => { throw new Error(sentinel); });
      if (part === 'resources') dependencies.capture.mockImplementation(() => { throw new Error(sentinel); });
      if (part === 'identity') dependencies.verify.mockRejectedValue(new Error(sentinel));
      await expect(wait()).rejects.toThrow(/inspection-failure/);
      expect(diagnostic().reason).toBe('inspection-failure');
    });

    it.each(['namespaces', 'processes', 'cgroups', 'identity'])('rejects extra or mismatched %s', async (part) => {
      progress = { ...progress!, stage: 'ready', state: 'ready' };
      if (part === 'identity') dependencies.verify.mockResolvedValue('mismatch');
      else dependencies.capture.mockReturnValue({ ...primary, [part]: [...primary[part as keyof VmResidue], sentinel] });
      await expect(wait()).rejects.toThrow(/unexpected-resources/);
      expect(diagnostic()).toMatchObject({
        reason: 'unexpected-resources', resources: { identity: 'mismatch' },
      });
    });

    const createReadinessFixture = (contents?: string) => {
      const fixtureDirectory = fs.mkdtempSync(path.join(directory, 'readiness-'));
      const recordDirectory = path.join(fixtureDirectory, PRIMARY_READINESS_DIRECTORY);
      fs.mkdirSync(recordDirectory);
      const file = path.join(recordDirectory, PRIMARY_READINESS_FILENAME);
      if (contents !== undefined) fs.writeFileSync(file, contents, { mode: 0o600 });
      return { fixtureDirectory, recordDirectory, file };
    };

    it('reads only complete, private, owner-matched, allowlisted progress records', () => {
      const { recordDirectory, file } = createReadinessFixture();
      const reporter = createPrimaryReadinessReporter(recordDirectory);
      reporter.publish('guest-boot', 'starting', 1, '/private/primary');
      expect(harness.readPrimaryVmProgress(file, child)).toMatchObject({ state: 'starting' });
      reporter.publish('ready', 'ready', 1, '/private/primary');
      reporter.close();
      expect(harness.readPrimaryVmProgress(file, child)).toMatchObject({ state: 'ready', runId: 'primary' });
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let valid: Record<string, unknown>;
      try {
        expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
        valid = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      } finally {
        fs.closeSync(descriptor);
      }
      for (const invalid of [
        { ...valid, ownerPid: child.pid + 1 }, { ...valid, state: sentinel },
        { ...valid, stage: sentinel }, { ...valid, extra: sentinel },
        { ...valid, bootAttempt: 0 }, { ...valid, runId: '../../private' },
        { ...valid, stage: 'guest-boot' }, { ...valid, schemaVersion: 2 },
      ]) {
        const fixture = createReadinessFixture(JSON.stringify(invalid));
        expect(harness.readPrimaryVmProgress(fixture.file, child)).toBeUndefined();
      }
      const malformed = createReadinessFixture('{"stage":');
      expect(harness.readPrimaryVmProgress(malformed.file, child)).toBeUndefined();
      const oversized = createReadinessFixture(sentinel.repeat(4096));
      expect(() => harness.readPrimaryVmProgress(oversized.file, child)).toThrow(/inspection failed/);

      const unsafeMode = createReadinessFixture(JSON.stringify(valid));
      fs.chmodSync(unsafeMode.file, 0o644);
      expect(() => harness.readPrimaryVmProgress(unsafeMode.file, child)).toThrow(/inspection failed/);

      const symlink = createReadinessFixture();
      const target = path.join(symlink.fixtureDirectory, 'target');
      fs.writeFileSync(target, sentinel);
      fs.symlinkSync(target, symlink.file);
      expect(() => harness.readPrimaryVmProgress(symlink.file, child)).toThrow(/inspection failed/);
    });

    it('safely replaces a stale readiness record on restart and rejects unsafe existing targets', () => {
      const { recordDirectory, file } = createReadinessFixture();
      const first = createPrimaryReadinessReporter(recordDirectory);
      first.publish('ready', 'ready', 1, '/private/previous');
      first.close();
      const second = createPrimaryReadinessReporter(recordDirectory);
      second.publish('preflight', 'starting', 0);
      second.close();
      expect(harness.readPrimaryVmProgress(file, child)).toMatchObject({
        state: 'starting', runId: null, bootAttempt: 0,
      });

      const unsafeMode = createReadinessFixture(sentinel);
      fs.chmodSync(unsafeMode.file, 0o644);
      expect(() => createPrimaryReadinessReporter(unsafeMode.recordDirectory)).toThrow(/Unsafe/);

      const symlink = createReadinessFixture();
      const symlinkTarget = path.join(symlink.fixtureDirectory, 'symlink-target');
      fs.writeFileSync(symlinkTarget, sentinel);
      fs.symlinkSync(symlinkTarget, symlink.file);
      const symlinkTargetFd = fs.openSync(symlinkTarget, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(() => createPrimaryReadinessReporter(symlink.recordDirectory)).toThrow();
        expect(fs.readFileSync(symlinkTargetFd, 'utf8')).toBe(sentinel);
      } finally {
        fs.closeSync(symlinkTargetFd);
      }

      const hardlink = createReadinessFixture();
      const hardlinkTarget = path.join(hardlink.fixtureDirectory, 'hardlink-target');
      fs.writeFileSync(hardlinkTarget, sentinel);
      fs.linkSync(hardlinkTarget, hardlink.file);
      const hardlinkTargetFd = fs.openSync(hardlinkTarget, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(() => createPrimaryReadinessReporter(hardlink.recordDirectory)).toThrow(/Unsafe/);
        expect(fs.readFileSync(hardlinkTargetFd, 'utf8')).toBe(sentinel);
      } finally {
        fs.closeSync(hardlinkTargetFd);
      }
    });

    const linuxIt = process.platform === 'linux' ? it : it.skip;
    linuxIt('verifies durable primary ownership and rejects substituted live resource identities', async () => {
      const { captureProcessIdentity } = require('../../dist/cloud-hypervisor/cleanup-process');
      const owner = await captureProcessIdentity(fs.promises, process.pid);
      const namespace = fs.statSync('/proc/self/ns/net');
      const runId = 'primary';
      const vmm = {
        ...owner, networkNamespace: `net:[${namespace.ino}]`,
      };
      const record = {
        version: 1, runId, owner,
        workload: { kind: 'primary-agent', ownerId: 'primary-agent' },
        cloudHypervisorBinary: process.execPath,
        paths: {
          runDirectory: `/private/runs/${runId}`,
          cgroupPath: `/sys/fs/cgroup/awf-cloud-hypervisor/${runId}`,
          virtiofsdShareDirectory: `/private/shares/${runId}`,
        },
        network: {
          mode: 'primary', namespaceName: primary.namespaces[0],
          netnsPath: `/var/run/netns/${primary.namespaces[0]}`,
          hostForwardRuleComment: 'awf-microvm-0123456789ab', infrastructureBridge: 'awfbr0',
        },
        identities: {
          cgroup: { device: '1', inode: '789' },
          netns: { device: String(namespace.dev), inode: String(namespace.ino) },
        },
        processes: {
          vmm: {
            state: 'live', identity: vmm, executable: process.execPath,
            // The real verifier checks this against the live test process argv.
            socketPath: fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0')
              .find((argument) => path.isAbsolute(argument)),
          },
        },
        mounts: [], updatedAt: new Date().toISOString(),
      };
      const journal = path.join(directory, 'journal.json');
      fs.writeFileSync(journal, JSON.stringify(record), { mode: 0o600 });
      const nodeFs = require('fs') as typeof fs;
      const open = fs.openSync;
      const stat = fs.statSync;
      const read = fs.readFileSync;
      jest.spyOn(nodeFs, 'openSync').mockImplementation((file, ...args) => open(
        file === '/run/awf-cloud-hypervisor/pending-cleanup/primary.json' ? journal : file, ...args,
      ));
      jest.spyOn(nodeFs, 'statSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
        String(file) === record.network.netnsPath ? namespace : stat(file, ...args as [])) as typeof fs.statSync);
      jest.spyOn(nodeFs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) =>
        String(file) === `/proc/${process.pid}/cgroup`
          ? `0::/awf-cloud-hypervisor/${runId}\n` : read(file, ...args as [])) as typeof fs.readFileSync);
      const observed = { ...primary, processes: [{ pid: String(vmm.pid), startTime: vmm.startTime }] };
      progress = { ...progress!, runId, stage: 'ready', state: 'ready' };
      const { validateRecord } = require('../../dist/cloud-hypervisor/cleanup-identity');
      expect(() => validateRecord(record,
        '/run/awf-cloud-hypervisor/pending-cleanup/primary.json',
        '/run/awf-cloud-hypervisor/pending-cleanup')).not.toThrow();
      const { processMatches } = require('../../dist/cloud-hypervisor/cleanup-process');
      await expect(processMatches(fs.promises, owner)).resolves.toBe(true);
      await expect(processMatches(fs.promises, vmm, record.processes.vmm)).resolves.toBe(true);
      await expect(harness.verifyPrimaryVmIdentity(progress, child, observed)).resolves.toBe('verified');
      for (const changed of [
        { ...record, owner: { ...owner, pid: owner.pid + 1 } },
        { ...record, owner: { ...owner, startTime: '1' } },
        { ...record, workload: { kind: 'agent-enclave', ownerId: 'primary-agent', invocationId: 'a'.repeat(32) } },
        { ...record, identities: { ...record.identities, cgroup: { device: '1', inode: '790' } } },
        { ...record, identities: { ...record.identities, netns: { device: '1', inode: '2' } } },
        { ...record, processes: { vmm: { ...record.processes.vmm, socketPath: '/unrelated/socket' } } },
      ]) {
        fs.writeFileSync(journal, JSON.stringify(changed));
        await expect(harness.verifyPrimaryVmIdentity(progress, child, observed)).resolves.toBe('mismatch');
      }
    });

    it('uses the same gate for the initial, recovery, and single-executor harness launches', () => {
      const liveSource = fs.readFileSync(harnessPath, 'utf8');
      const probeSource = fs.readFileSync(path.join(root,
        'scripts/ci/cloud-hypervisor-enclave-environment-probe.js'), 'utf8');
      expect(liveSource.match(/waitForPrimaryVmReadiness\(\s*awf,/g)).toHaveLength(3);
      expect(liveSource).toContain(
        "primaryVmResidue = await acceptanceCheck(failureContext, 'crash-recovery', 'primary-readiness',",
      );
      expect(probeSource).toContain('primaryVmResidue = await live.waitForPrimaryVmReadiness(');
      expect(liveSource).not.toContain('capturePrimaryVmResidue');
      expect(probeSource).not.toContain('capturePrimaryVmResidue');
      expect(probeSource.indexOf('live.waitForPrimaryVmReadiness(')).toBeLessThan(probeSource.indexOf("'tools/call'"));
    });
  });

  it('identifies the Copilot token prerequisite with its fixed stage label', () => {
    const originalExitCode = process.exitCode;
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      harness.reportFailure(new Error(sentinel), 'COPILOT_GITHUB_TOKEN prerequisite');
      expect(output).toHaveBeenCalledWith(expected('COPILOT_GITHUB_TOKEN prerequisite'));
      expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('falls back to a constant label for unrecognized stages', () => {
    const originalExitCode = process.exitCode;
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.exitCode = 0;
      harness.reportFailure(new Error('failure'), sentinel);
      expect(output).toHaveBeenCalledWith(expected('unknown stage'));
      expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

describe('intermediate Cloud Hypervisor cleanup with a live primary VM', () => {
  const primary = {
    namespaces: ['awfvm-primary'],
    processes: [{ pid: '123', startTime: '456' }],
    cgroups: [{ name: 'primary', device: 1, inode: 789 }],
  };

  it('accepts the exact still-live primary and rejects added enclave residue', () => {
    expect(() => harness.assertNoVmResidue(primary, primary)).not.toThrow();
    for (const observed of [
      { ...primary, namespaces: [...primary.namespaces, 'awfvm-enclave'] },
      { ...primary, processes: [...primary.processes, { pid: '124', startTime: '457' }] },
      { ...primary, cgroups: [...primary.cgroups, { name: 'enclave', device: 1, inode: 790 }] },
    ]) {
      expect(() => harness.assertNoVmResidue(primary, observed))
        .toThrow('Cloud Hypervisor enclave resource residue remains');
    }
  });

  it('requires exactly one primary VM identity before allowing intermediate residue', () => {
    expect(() => harness.assertNoVmResidue({
      ...primary, processes: [...primary.processes, { pid: '124', startTime: '457' }],
    }, primary)).toThrow('Could not verify the live Cloud Hypervisor primary VM');
  });
});
