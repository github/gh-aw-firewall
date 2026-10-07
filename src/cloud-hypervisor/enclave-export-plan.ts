import { promises as fs } from 'fs';
import * as path from 'path';
import {
  HOST_EXECUTOR_ENTRY_ID_PATTERN,
  HOST_EXECUTOR_ID_PATTERN,
} from '../enclave/host-executor-protocol';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import {
  validateCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './exports';

export type CloudHypervisorEnclaveExportRole = 'script' | 'agent';

export interface CloudHypervisorEnclaveExportPlan {
  readonly role: CloudHypervisorEnclaveExportRole;
  readonly runId: string;
  readonly entryId: string;
  readonly invocationId: string;
  readonly seedId: string;
  readonly seedsDir: string;
  readonly invocationsDir: string;
  readonly invocationHostDir: string;
  readonly exports: readonly CloudHypervisorDirectoryExport[];
}

const ROLE_EXPORTS = {
  script: [
    { tag: 'enclave-seed', target: '/input-seed', mode: 'ro', source: 'seed' },
    { tag: 'enclave-request', target: '/input-request', mode: 'ro', source: 'request' },
    { tag: 'enclave-output', target: '/output', mode: 'rw', source: 'output' },
    { tag: 'enclave-runtime', target: '/runtime', mode: 'rw', source: 'runtime' },
  ],
  agent: [
    { tag: 'enclave-seed', target: '/input-seed', mode: 'ro', source: 'seed' },
    { tag: 'enclave-request', target: '/input-request', mode: 'ro', source: 'request' },
    { tag: 'enclave-output', target: '/output', mode: 'rw', source: 'output' },
    { tag: 'enclave-runtime', target: '/runtime', mode: 'rw', source: 'runtime' },
    {
      tag: 'enclave-session-handoff',
      target: '/session-handoff',
      mode: 'ro',
      source: 'session-handoff',
    },
    {
      tag: 'enclave-session-state',
      target: '/session-state',
      mode: 'rw',
      source: 'session-state',
    },
  ],
} as const;
const MAX_ENCLAVE_EXPORTS = ROLE_EXPORTS.agent.length;

/**
 * Resolves the enclave's closed filesystem layout from host-executor run state.
 * It performs no directory creation or other filesystem writes. The caller
 * must prepare the invocation subdirectories before requesting this plan.
 */
export async function resolveCloudHypervisorEnclaveExportPlan(
  runState: HostExecutorRunState,
  invocation: HostExecutorInvocationPlan,
): Promise<CloudHypervisorEnclaveExportPlan> {
  assertClosedKeys(runState, ['runId', 'seedsDir', 'invocationsDir', 'entries'], 'run state');
  assertClosedKeys(invocation, [
    'runId',
    'entryId',
    'invocationId',
    'executorKind',
    'timeoutMs',
    'requestHash',
    'admissionId',
    'schemaHash',
    'schema',
    'payload',
    'invocationHostDir',
    'seedId',
    'seedHostPath',
  ], 'invocation plan');
  for (const entry of runState.entries) {
    assertClosedKeys(entry, [
      'entryId', 'executorKind', 'timeoutMs', 'staticSeedIds', 'dynamicAgents',
    ], 'entry policy');
  }
  const role = invocation.executorKind;
  if (role !== 'script' && role !== 'agent') {
    throw new Error('Unsupported Cloud Hypervisor enclave export role');
  }
  if (
    !HOST_EXECUTOR_ID_PATTERN.test(runState.runId) ||
    !HOST_EXECUTOR_ENTRY_ID_PATTERN.test(invocation.entryId) ||
    !HOST_EXECUTOR_ID_PATTERN.test(invocation.invocationId) ||
    invocation.runId !== runState.runId
  ) {
    throw new Error('Cloud Hypervisor enclave export identity does not match trusted run state');
  }
  const matchingEntries = runState.entries.filter(({ entryId }) => entryId === invocation.entryId);
  const entry = matchingEntries[0];
  if (matchingEntries.length !== 1 || !entry || entry.executorKind !== role) {
    throw new Error('Cloud Hypervisor enclave export role does not match trusted entry policy');
  }
  if (
    invocation.seedId === undefined ||
    invocation.seedHostPath === undefined ||
    !HOST_EXECUTOR_ID_PATTERN.test(invocation.seedId) ||
    entry.staticSeedIds.filter((seedId) => seedId === invocation.seedId).length !== 1 ||
    !entry.staticSeedIds.includes(invocation.seedId) ||
    invocation.seedHostPath !== path.join(runState.seedsDir, invocation.seedId)
  ) {
    throw new Error('Cloud Hypervisor enclave exports require a trusted static seed');
  }
  const expectedInvocationDirectory = path.join(
    runState.invocationsDir,
    invocation.entryId,
    invocation.invocationId,
  );
  if (invocation.invocationHostDir !== expectedInvocationDirectory) {
    throw new Error('Cloud Hypervisor enclave invocation path does not match trusted run state');
  }

  const rootDirectories = [
    runState.seedsDir,
    runState.invocationsDir,
  ];
  for (const directory of rootDirectories) await assertRealDirectory(directory);

  const definitions = role === 'script' ? ROLE_EXPORTS.script : ROLE_EXPORTS.agent;
  const exports = await Promise.all(definitions.map(async (definition) => {
    const source = definition.source === 'seed'
      ? invocation.seedHostPath!
      : path.join(expectedInvocationDirectory, definition.source);
    await assertRealDirectory(source);
    return {
      tag: definition.tag,
      source,
      target: definition.target,
      mode: definition.mode,
    } as CloudHypervisorDirectoryExport;
  }));

  const validated = validateCloudHypervisorExports(exports, {
    requireWorkspace: false,
    maxExports: MAX_ENCLAVE_EXPORTS,
  });
  assertNonOverlappingSources(validated);
  return Object.freeze({
    role,
    runId: runState.runId,
    entryId: invocation.entryId,
    invocationId: invocation.invocationId,
    seedId: invocation.seedId,
    seedsDir: runState.seedsDir,
    invocationsDir: runState.invocationsDir,
    invocationHostDir: expectedInvocationDirectory,
    exports: Object.freeze(validated),
  });
}

export function validateCloudHypervisorEnclaveExportPlan(
  plan: CloudHypervisorEnclaveExportPlan,
  role: CloudHypervisorEnclaveExportRole,
  identity?: { readonly entryId: string; readonly invocationId: string },
): CloudHypervisorDirectoryExport[] {
  assertClosedKeys(plan, [
    'role',
    'runId',
    'entryId',
    'invocationId',
    'seedId',
    'seedsDir',
    'invocationsDir',
    'invocationHostDir',
    'exports',
  ], 'export plan');
  if (!plan || plan.role !== role || !Array.isArray(plan.exports)) {
    throw new Error(`Cloud Hypervisor ${role}-enclave requires its trusted export plan`);
  }
  const definitions = role === 'script' ? ROLE_EXPORTS.script : ROLE_EXPORTS.agent;
  if (
    !HOST_EXECUTOR_ID_PATTERN.test(plan.runId) ||
    !HOST_EXECUTOR_ENTRY_ID_PATTERN.test(plan.entryId) ||
    !HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId) ||
    !HOST_EXECUTOR_ID_PATTERN.test(plan.seedId) ||
    !path.isAbsolute(plan.seedsDir) ||
    path.normalize(plan.seedsDir) !== plan.seedsDir ||
    plan.seedsDir === '/' ||
    !path.isAbsolute(plan.invocationsDir) ||
    path.normalize(plan.invocationsDir) !== plan.invocationsDir ||
    plan.invocationsDir === '/' ||
    plan.invocationHostDir !== path.join(plan.invocationsDir, plan.entryId, plan.invocationId) ||
    (identity !== undefined &&
      (identity.entryId !== plan.entryId || identity.invocationId !== plan.invocationId))
  ) {
    throw new Error(`Cloud Hypervisor ${role}-enclave export plan identity is invalid`);
  }
  if (plan.exports.length !== definitions.length) {
    throw new Error(`Cloud Hypervisor ${role}-enclave export set is incomplete or contains extras`);
  }
  const sourceByTag = new Map(plan.exports.map((entry) => [entry.tag, entry]));
  for (const entry of plan.exports) {
    assertClosedKeys(entry, ['tag', 'source', 'target', 'mode'], 'export');
  }
  for (const definition of definitions) {
    const entry = sourceByTag.get(definition.tag);
    if (
      !entry ||
      entry.target !== definition.target ||
      entry.mode !== definition.mode ||
      entry.source !== (definition.source === 'seed'
        ? path.join(plan.seedsDir, plan.seedId)
        : path.join(plan.invocationHostDir, definition.source)) ||
      !path.isAbsolute(entry.source) ||
      path.normalize(entry.source) !== entry.source
    ) {
      throw new Error(`Cloud Hypervisor ${role}-enclave has an invalid "${definition.tag}" export`);
    }
  }
  const validated = validateCloudHypervisorExports(plan.exports, {
    requireWorkspace: false,
    maxExports: MAX_ENCLAVE_EXPORTS,
  });
  assertNonOverlappingSources(validated);
  if (validated.some((entry) => entry.tag === 'workspace' || entry.target === '/workspace')) {
    throw new Error(`Cloud Hypervisor ${role}-enclave must not expose a primary workspace`);
  }
  return validated;
}

async function assertRealDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === '/') {
    throw new Error(`Cloud Hypervisor enclave export source must be a clean absolute path: ${directory}`);
  }
  let resolved: string;
  try {
    resolved = await fs.realpath(directory);
    const stat = await fs.lstat(directory);
    if (resolved !== directory || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('not a canonical real directory');
    }
  } catch (error) {
    throw new Error(
      `Cloud Hypervisor enclave export source must be an existing real directory: ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertNonOverlappingSources(exports: readonly CloudHypervisorDirectoryExport[]): void {
  for (const [index, entry] of exports.entries()) {
    for (const other of exports.slice(index + 1)) {
      const first = entry.source;
      const second = other.source;
      const firstToSecond = path.relative(first, second);
      const secondToFirst = path.relative(second, first);
      if (
        firstToSecond === '' ||
        secondToFirst === '' ||
        (!firstToSecond.startsWith(`..${path.sep}`) && firstToSecond !== '..') ||
        (!secondToFirst.startsWith(`..${path.sep}`) && secondToFirst !== '..')
      ) {
        throw new Error(
          `Cloud Hypervisor enclave exports have overlapping host sources: ${first} and ${second}`,
        );
      }
    }
  }
}

function assertClosedKeys(value: object, allowedKeys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`Cloud Hypervisor enclave ${label} is required`);
  }
  const unknown = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new Error(`Unknown Cloud Hypervisor enclave ${label} field: ${unknown}`);
}
