import {
  describeLinux, useDockerHostExecutorFixture, runId, binding,
  type DockerHostExecutorTestFixture, type FakeDocker,
} from './docker-host-executor.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import { recoverDockerHostEnclaveExecutor, type DockerHostExecutorEntry } from './docker-host-executor';
import {
  assertDockerHostContainer, DockerHostRecoveryJournal, removeDockerHostContainer,
  assertDockerHostOwnerStopped, captureDockerHostOwner, type DockerHostRecoveryRecord,
} from './docker-host-recovery';
import { cleanupDockerHostStorage } from './docker-host-storage';
import type { HostExecutorInvocationPlan } from './host-executor-server';

describeLinux('host-owned Docker enclave executor recovery', () => {
  const getFixture = useDockerHostExecutorFixture();
  let root: string;
  let docker: FakeDocker;
  let plan: HostExecutorInvocationPlan;
  let script: DockerHostExecutorEntry;
  let agent: DockerHostExecutorEntry;
  let backend: DockerHostExecutorTestFixture['backend'];
  let dynamicPlan: DockerHostExecutorTestFixture['dynamicPlan'];

  beforeEach(() => {
    ({ root, docker, plan, script, agent, backend, dynamicPlan } = getFixture());
  });

  describe.each(['copilot', 'codex', 'claude'])('%s supervisor lifecycle', engine => {
    function agentPlan(): HostExecutorInvocationPlan {
      agent.config = { ...agent.config, engine };
      return { ...plan, entryId: 'agent', executorKind: 'agent' };
    }

    test.each(['additional', 'missing', 'legacy'] as const)('capability verification is exact for %s records', async kind => {
      const invocation = agentPlan();
      docker.onWorkloadStart = () => { docker.failRemoval = true; };
      await backend([agent]).execute(invocation, new AbortController().signal);
      const record = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0];
      const container = [...docker.containers.values()][0];
      if (kind === 'additional') container.HostConfig.CapAdd.push('SYS_ADMIN');
      if (kind === 'missing') container.HostConfig.CapAdd.pop();
      if (kind === 'legacy') delete record.expected!.capAdd;
      if (kind === 'legacy') {
        expect(() => assertDockerHostContainer(container, record.expected!, record.containerId)).not.toThrow();
        container.HostConfig.CapAdd.push('NET_ADMIN');
      }
      expect(() => assertDockerHostContainer(container, record.expected!, record.containerId)).toThrow(/configuration mismatch/);
      await expect(removeDockerHostContainer(docker.command, record)).rejects.toThrow(/configuration mismatch/);
      expect(docker.containers.size).toBe(1);
    });

    test('recovers a legacy supervisor journal only after exact identity and removal proof', async () => {
      const invocation = agentPlan();
      docker.onWorkloadStart = () => { docker.failRemoval = true; };
      const executor = backend([agent]);
      await expect(executor.execute(invocation, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
      const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
      const record = journal.records()[0];
      delete record.expected!.capAdd;
      journal.write(record);
      docker.failRemoval = false;
      await recoverDockerHostEnclaveExecutor({
        runId, journalDir: journal.directory, entries: [agent], dockerCommand: docker.command,
      });
      expect(docker.containers.size).toBe(0);
      expect(journal.records()).toEqual([]);
      expect(fs.existsSync(invocation.invocationHostDir)).toBe(false);
    });
  });

  test('a workload failure with uncertain removal cannot be classified as recoverable', async () => {
    docker.workloadExitCode = 1;
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    const executor = backend();
    await expect(executor.execute(plan, new AbortController().signal)).resolves.toEqual({
      outcome: 'executor-failure', cleanupComplete: false,
    });
    await expect(executor.close!()).rejects.toThrow(/recovery/);
  });

  test('unknown create completion fails closed and retains the mount/journal', async () => {
    docker.pendingCreate = true;
    const executor = backend();
    await expect(executor.execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0].createPending).toBe(true);
  });

  test('new host instance recovers a labelled, inspected immutable container after interrupted cleanup', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    docker.failRemoval = false;
    const recovered = backend();
    await recovered.prepare();
    await recovered.close!();
    expect(docker.containers.size).toBe(0);
    expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(root, 'journal'))).toEqual([]);
  });

  test('a new run reconciles verified allocations from older run IDs', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    record.owner = { ...record.owner, pid: 2147483647, startTicks: '1' };
    journal.write(record);
    docker.failRemoval = false;
    const nextRun = 'e'.repeat(32);
    const recovered = backend([script], { runId: nextRun });
    await recovered.prepare();
    await recovered.close!();
    expect(docker.containers.size).toBe(0);
    expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
    expect(journal.records(true)).toEqual([]);
  });

  test('a new run preserves allocations owned by another live host process', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    const parentStat = fs.readFileSync(`/proc/${process.ppid}/stat`, 'utf8');
    record.owner = {
      ...record.owner, pid: process.ppid,
      startTicks: parentStat.slice(parentStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
    };
    journal.write(record);
    const nextRun = 'e'.repeat(32);
    const recovered = backend([script], { runId: nextRun });
    await recovered.prepare();
    await recovered.close!();
    expect(docker.containers.size).toBe(1);
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
  });

  test('recovers the create-before-ID-journal window only after inspected config verification', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    delete record.containerId;
    record.createPending = true;
    journal.write(record);
    docker.failRemoval = false;
    const recovered = backend();
    await recovered.prepare();
    await recovered.close!();
    expect(docker.containers.size).toBe(0);
    expect(journal.records()).toEqual([]);
  });

  test('recovery does not remove containers with spoofed labels but wrong launch settings', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    docker.failRemoval = false;
    const container = [...docker.containers.values()][0];
    container.HostConfig.ReadonlyRootfs = false;
    const removalCount = docker.calls.filter((c) => c[0] === 'rm').length;
    const recovered = backend();
    await expect(recovered.prepare()).rejects.toThrow('mismatch');
    await expect(recovered.close!()).rejects.toThrow('mismatch');
    expect(docker.calls.filter((c) => c[0] === 'rm')).toHaveLength(removalCount);
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
  });

  test('immutable ID mismatch cannot authorize removal', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const record = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0];
    const inspected = [...docker.containers.values()][0];
    expect(() => assertDockerHostContainer(inspected, record.expected!, '9'.repeat(64))).toThrow('mismatch');
    await expect(removeDockerHostContainer(docker.command, { ...record, containerId: '9'.repeat(64) } as DockerHostRecoveryRecord))
      .rejects.toThrow('mismatch');
  });

  test.each([
    ['extra network', (c: any) => { c.NetworkSettings.Networks['awf-net'] = {}; }],
    ['privilege', (c: any) => { c.HostConfig.Privileged = true; }],
    ['writable root', (c: any) => { c.HostConfig.ReadonlyRootfs = false; }],
    ['resource widening', (c: any) => { c.HostConfig.Memory = 2 ** 32; }],
    ['root identity', (c: any) => { c.Config.User = '0:0'; }],
    ['writable seed', (c: any) => { c.Mounts.find((m: any) => m.Destination === '/awf/seed').RW = true; }],
  ])('recovery rejects %s even with matching durable labels', async (_name, mutate) => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const record = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0];
    const inspected = [...docker.containers.values()][0];
    mutate(inspected);
    expect(() => assertDockerHostContainer(inspected, record.expected!, record.containerId)).toThrow('mismatch');
  });

  test('host-owned startup preparation reconciles before dynamic authority is requested', async () => {
    const authority = jest.fn(async () => ({}));
    const executor = backend([agent], { resolveAgentAuthority: authority });
    await executor.prepare();
    await executor.prepare();
    expect(docker.calls.filter((c) => c[0] === 'info')).toHaveLength(1);
    expect(docker.calls.some((c) => c[0] === 'create')).toBe(false);
    expect(authority).not.toHaveBeenCalled();
  });

  test('standalone stopped-run recovery proves container removal before seed cleanup', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    docker.failRemoval = false;
    await recoverDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries: [script], dockerCommand: docker.command,
    });
    expect(docker.containers.size).toBe(0);
    expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(plan.seedHostPath!)).toBe(true);
  });

  test('recovery refuses another active in-process owner', async () => {
    const controller = new AbortController();
    docker.holdWorkload = true;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    docker.onWorkloadStart = started;
    const execution = backend().execute(plan, controller.signal);
    await running;
    const removalCount = docker.calls.filter((c) => c[0] === 'rm').length;
    await expect(backend().prepare()).rejects.toThrow('another active host executor');
    expect(docker.calls.filter((c) => c[0] === 'rm')).toHaveLength(removalCount);
    controller.abort();
    await expect(execution).resolves.toEqual({ outcome: 'cancelled' });
  });

  test('host PID/starttime/boot identity rejects live foreign owners and unknown ownership', () => {
    const current = captureDockerHostOwner();
    const parentStat = fs.readFileSync(`/proc/${process.ppid}/stat`, 'utf8');
    const parentStart = parentStat.slice(parentStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    expect(() => assertDockerHostOwnerStopped({ ...current, pid: process.ppid, startTicks: parentStart }, current))
      .toThrow('still alive');
    expect(() => assertDockerHostOwnerStopped(undefined, current)).toThrow('verified host ownership');
    expect(() => assertDockerHostOwnerStopped({ ...current, pid: 2147483647 }, current)).not.toThrow();
    expect(() => assertDockerHostOwnerStopped({ ...current, pid: process.ppid, startTicks: '0' }, current)).not.toThrow();
  });

  test('stopped-run dynamic resource recovery never mints or settles a new identity', async () => {
    const dynamic = dynamicPlan();
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    const admit = jest.fn(async () => binding);
    const settle = jest.fn(async () => ({ revoked: true }));
    await backend([agent], { resolveAgentAuthority: admit, settleAgentAuthority: settle })
      .execute(dynamic, new AbortController().signal);
    docker.failRemoval = false;
    await recoverDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries: [agent], dockerCommand: docker.command,
    });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(docker.containers.size).toBe(0);
  });
});
