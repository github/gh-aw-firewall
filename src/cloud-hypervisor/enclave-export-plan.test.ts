import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  resolveCloudHypervisorEnclaveExportPlan,
  validateCloudHypervisorEnclaveExportPlan,
} from './enclave-export-plan';
import { buildSupervisorBootArgs, encodeVirtiofsBootArg } from './vm-config-builder';
import { createTestNetworkPlan } from './manager.test-utils';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';

interface MutableExport {
  tag: string;
  source: string;
  target: string;
  mode: 'ro' | 'rw';
}

const invalidPlanMutations: Array<[string, (exports: MutableExport[]) => void]> = [
  ['writable seed', (exports) => { exports[0].mode = 'rw'; }],
  ['unexpected export', (exports) => {
    exports.push({ tag: 'home', source: '/home', target: '/home', mode: 'ro' });
  }],
  ['modified target', (exports) => { exports[0].target = '/workspace'; }],
  ['duplicate target', (exports) => { exports[1].target = exports[0].target; }],
  ['caller permission override', (exports) => { Object.assign(exports[0], { permissions: 'rw' }); }],
  ['session export in script role', (exports) => {
    exports.push({
      tag: 'enclave-session-state',
      source: '/state',
      target: '/session-state',
      mode: 'rw',
    });
  }],
];

describe('Cloud Hypervisor enclave export plans', () => {
  let root: string;
  const runId = 'a'.repeat(32);
  const entryId = 'script-entry';
  const invocationId = 'b'.repeat(32);
  const seedId = 'c'.repeat(32);

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ch-enclave-exports-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(role: 'script' | 'agent') {
    const seedsDir = path.join(root, 'seeds');
    const invocationsDir = path.join(root, 'invocations');
    const invocationHostDir = path.join(invocationsDir, entryId, invocationId);
    const seedHostPath = path.join(seedsDir, seedId);
    await fs.mkdir(seedHostPath, { recursive: true });
    const names = ['request', 'output', 'runtime'];
    if (role === 'agent') names.push('session-handoff', 'session-state');
    await Promise.all(names.map((name) => fs.mkdir(path.join(invocationHostDir, name), {
      recursive: true,
    })));

    const runState: HostExecutorRunState = {
      runId,
      seedsDir,
      invocationsDir,
      entries: [{
        entryId,
        executorKind: role,
        staticSeedIds: [seedId],
        dynamicAgents: false,
      }],
    };
    const invocation: HostExecutorInvocationPlan = {
      runId,
      entryId,
      invocationId,
      executorKind: role,
      requestHash: 'd'.repeat(64),
      admissionId: 'e'.repeat(32),
      schemaHash: 'f'.repeat(64),
      payload: 'trusted bounded payload',
      invocationHostDir,
      seedId,
      seedHostPath,
    };
    return { runState, invocation, seedHostPath, invocationHostDir };
  }

  it.each([
    ['script', [
      ['enclave-seed', 'input-seed', 'ro', 'seed'],
      ['enclave-request', 'input-request', 'ro', 'request'],
      ['enclave-output', 'output', 'rw', 'output'],
      ['enclave-runtime', 'runtime', 'rw', 'runtime'],
    ]],
    ['agent', [
      ['enclave-seed', 'input-seed', 'ro', 'seed'],
      ['enclave-request', 'input-request', 'ro', 'request'],
      ['enclave-output', 'output', 'rw', 'output'],
      ['enclave-runtime', 'runtime', 'rw', 'runtime'],
      ['enclave-session-handoff', 'session-handoff', 'rw', 'session-handoff'],
      ['enclave-session-state', 'session-state', 'rw', 'session-state'],
    ]],
  ] as const)('resolves the exact %s role layout with host-enforced access modes', async (role, expected) => {
    const { runState, invocation, seedHostPath, invocationHostDir } = await fixture(role);
    const plan = await resolveCloudHypervisorEnclaveExportPlan(runState, invocation);
    expect(plan.role).toBe(role);
    expect(plan.exports).toEqual(expected.map(([tag, target, mode, source]) => ({
      tag,
      source: source === 'seed' ? seedHostPath : path.join(invocationHostDir, source),
      target: `/${target}`,
      mode,
    })));
    expect(plan.exports).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: '/workspace' }),
    ]));
    expect(validateCloudHypervisorEnclaveExportPlan(plan, role)).toEqual(plan.exports);
    const networkPlan = role === 'agent' ? createTestNetworkPlan() : undefined;
    const bootArgs = buildSupervisorBootArgs(networkPlan, {
      exports: plan.exports,
      supervisorBinaryPath: '/opt/awf-supervisor',
      supervisorSha256: 'a'.repeat(64),
      workspaceMount: null,
    });
    expect(bootArgs).toContain(`awf.virtiofs=${encodeVirtiofsBootArg(plan.exports, {
      requireWorkspace: false,
      maxExports: 6,
    })}`);
    expect(bootArgs).not.toContain('awf.workspace-mount=');
    if (role === 'agent') {
      execFileSync(
        'go',
        ['test', '-run', '^TestParseBootConfigAcceptsWorkspaceLessNetworkedVirtiofs$'],
        {
          cwd: path.resolve(__dirname, '../../guest/microvm-supervisor'),
          env: { ...process.env, AWF_TEST_BOOT_CMDLINE: bootArgs },
        },
      );
    }
  });

  it('rejects caller-selected host paths and role-inappropriate seed state before side effects', async () => {
    const { runState, invocation, invocationHostDir } = await fixture('script');
    const originalEntries = await fs.readdir(invocationHostDir);

    await expect(resolveCloudHypervisorEnclaveExportPlan(runState, {
      ...invocation,
      seedHostPath: path.join(root, 'caller-seed'),
    })).rejects.toThrow(/trusted static seed/);
    await expect(resolveCloudHypervisorEnclaveExportPlan(runState, {
      ...invocation,
      invocationHostDir: root,
    })).rejects.toThrow(/does not match trusted run state/);
    await expect(resolveCloudHypervisorEnclaveExportPlan({
      ...runState,
      entries: [{ ...runState.entries[0], executorKind: 'agent' }],
    }, invocation)).rejects.toThrow(/role does not match trusted entry policy/);

    expect(await fs.readdir(invocationHostDir)).toEqual(originalEntries);
  });

  it('rejects symlink sources and missing writable directories without creating mounts', async () => {
    const { runState, invocation, invocationHostDir } = await fixture('script');
    const requestDirectory = path.join(invocationHostDir, 'request');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.rmdir(requestDirectory);
    await fs.symlink(outside, requestDirectory);
    await expect(resolveCloudHypervisorEnclaveExportPlan(runState, invocation))
      .rejects.toThrow(/existing real directory/);
    await fs.unlink(requestDirectory);
    await fs.mkdir(requestDirectory);
    await fs.rmdir(path.join(invocationHostDir, 'output'));
    await expect(resolveCloudHypervisorEnclaveExportPlan(runState, invocation))
      .rejects.toThrow(/existing real directory/);
    expect(await fs.readdir(invocationHostDir)).toEqual(['request', 'runtime']);
  });

  it('rejects overlapping host sources even when their guest targets are distinct', async () => {
    const { runState, invocation } = await fixture('script');
    const plan = await resolveCloudHypervisorEnclaveExportPlan(runState, invocation);
    const seedsDir = path.join(plan.invocationHostDir, 'request');
    const seedSource = path.join(seedsDir, plan.seedId);
    const overlapping = {
      ...plan,
      seedsDir,
      exports: plan.exports.map((entry) => (
        entry.tag === 'enclave-seed' ? { ...entry, source: seedSource } : entry
      )),
    };

    expect(() => validateCloudHypervisorEnclaveExportPlan(overlapping, 'script'))
      .toThrow(/overlapping host sources/);
  });

  it.each(invalidPlanMutations)('rejects %s from the closed role plan', async (_name, mutate) => {
    const { runState, invocation } = await fixture('script');
    const plan = await resolveCloudHypervisorEnclaveExportPlan(runState, invocation);
    const changedExports = structuredClone(plan.exports) as MutableExport[];
    mutate(changedExports);
    expect(() => validateCloudHypervisorEnclaveExportPlan({
      ...plan,
      exports: changedExports,
    }, 'script')).toThrow();
  });
});
