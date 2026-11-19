import {
  describeLinux, useDockerHostExecutorFixture, binding,
  type DockerHostExecutorTestFixture, type FakeDocker,
} from './docker-host-executor.test-utils';
import * as fs from 'fs';
import type { DockerHostExecutorEntry } from './docker-host-executor';
import { mountDockerHostStorage, cleanupDockerHostStorage } from './docker-host-storage';
import type { HostExecutorInvocationPlan } from './host-executor-server';

describeLinux('host-owned Docker enclave executor cancellation and revocation', () => {
  const getFixture = useDockerHostExecutorFixture();
  let docker: FakeDocker;
  let plan: HostExecutorInvocationPlan;
  let agent: DockerHostExecutorEntry;
  let backend: DockerHostExecutorTestFixture['backend'];
  let dynamicPlan: DockerHostExecutorTestFixture['dynamicPlan'];

  beforeEach(() => {
    ({ docker, plan, agent, backend, dynamicPlan } = getFixture());
  });

  describe.each(['copilot', 'codex', 'claude'])('%s supervisor lifecycle', engine => {
    function agentPlan(): HostExecutorInvocationPlan {
      agent.config = { ...agent.config, engine };
      return { ...plan, entryId: 'agent', executorKind: 'agent' };
    }

    test('settles cancellation only after stopping the active workload and removing storage', async () => {
      const invocation = agentPlan();
      const cancel = new AbortController();
      docker.holdWorkload = true;
      docker.onWorkloadStart = () => cancel.abort();
      const executor = backend([agent]);
      await expect(executor.execute(invocation, cancel.signal)).resolves.toEqual({ outcome: 'cancelled' });
      expect(docker.calls.some(args => args[0] === 'kill')).toBe(true);
      expect(docker.containers.size).toBe(0);
      expect(fs.existsSync(invocation.invocationHostDir)).toBe(false);
      await expect(executor.close()).resolves.toBeUndefined();
    });
  });

  test('cancellation kills/removes the immutable container before reclaiming storage', async () => {
    const cancellation = new AbortController();
    docker.holdWorkload = true;
    docker.onWorkloadStart = () => cancellation.abort();
    const executor = backend();
    await expect(executor.execute(plan, cancellation.signal)).resolves.toEqual({ outcome: 'cancelled' });
    expect(docker.calls.find((c) => c[0] === 'kill')?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
    expect(docker.containers.size).toBe(0);
  });

  test('closed host executor does not launch new invocations', async () => {
    const executor = backend();
    await executor.close!();
    await expect(executor.execute(plan, new AbortController().signal)).resolves.toEqual({ outcome: 'cancelled' });
    expect(docker.calls.some((c) => c[0] === 'create')).toBe(false);
  });

  test('closing an unopened duplicate backend cannot reconcile another live owner', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend().execute(plan, new AbortController().signal);
    const calls = docker.calls.length;
    await backend().close!();
    expect(docker.calls).toHaveLength(calls);
    expect(docker.containers.size).toBe(1);
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
  });

  test('settles and revokes cancellation after authority resolution but before journal or mount', async () => {
    const dynamic = dynamicPlan();
    const controller = new AbortController();
    const settle = jest.fn(async () => ({ revoked: true }));
    const executor = backend([agent], {
      resolveAgentAuthority: async () => { controller.abort(); return binding; },
      settleAgentAuthority: settle,
    });
    await expect(executor.execute(dynamic, controller.signal)).resolves.toEqual({ outcome: 'cancelled' });
    expect(settle).toHaveBeenCalledWith(dynamic, {
      outcome: 'cancelled', outputBytes: 0, executionSeconds: 0, cleanupComplete: true, uncertain: false,
    });
    expect(mountDockerHostStorage).not.toHaveBeenCalled();
  });

  test('does not release success until resource removal and authority revocation are both proved', async () => {
    const dynamic = dynamicPlan();
    let entered!: () => void;
    let revoked!: (value: { revoked: boolean }) => void;
    const settling = new Promise<void>((resolve) => { entered = resolve; });
    const receipt = new Promise<{ revoked: boolean }>((resolve) => { revoked = resolve; });
    const executor = backend([agent], {
      resolveAgentAuthority: async () => binding,
      settleAgentAuthority: async () => {
        expect(docker.containers.size).toBe(0);
        expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
        entered();
        return receipt;
      },
    });
    let released = false;
    const execution = executor.execute(dynamic, new AbortController().signal).then((value) => { released = true; return value; });
    await settling;
    expect(released).toBe(false);
    revoked({ revoked: true });
    await expect(execution).resolves.toEqual({ outcome: 'success', result: 'true' });
  });

  test('charges execution time from workload start rather than admission, staging or visibility probe', async () => {
    const dynamic = dynamicPlan();
    let now = 100_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const mount = jest.mocked(mountDockerHostStorage).getMockImplementation()!;
    jest.mocked(mountDockerHostStorage).mockImplementation(async (...args) => {
      now = 160_000;
      return mount(...args);
    });
    docker.onWorkloadStart = () => { now = 162_000; };
    const settle = jest.fn(async () => ({ revoked: true }));
    try {
      await backend([agent], {
        resolveAgentAuthority: async () => binding, settleAgentAuthority: settle,
      }).execute(dynamic, new AbortController().signal);
      expect(settle).toHaveBeenCalledWith(dynamic, expect.objectContaining({ executionSeconds: 2, uncertain: false }));
    } finally { clock.mockRestore(); }
  });

  test('uncertain container cleanup charges the configured maximum and still requires recovery after revocation', async () => {
    const dynamic = dynamicPlan();
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    const settle = jest.fn(async () => ({ revoked: true }));
    const executor = backend([agent], {
      resolveAgentAuthority: async () => binding, settleAgentAuthority: settle,
    });
    await expect(executor.execute(dynamic, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(settle).toHaveBeenCalledWith(dynamic, expect.objectContaining({
      outputBytes: 8192, executionSeconds: 120, cleanupComplete: false, uncertain: true,
    }));
    await expect(executor.close()).rejects.toThrow('cleanup requires recovery');
  });

  test('unknown admission failure is conservatively settled even without any container resources', async () => {
    const dynamic = dynamicPlan();
    const settle = jest.fn(async () => ({ revoked: true }));
    await expect(backend([agent], {
      resolveAgentAuthority: async () => { throw new Error('admission response uncertain'); },
      settleAgentAuthority: settle,
    }).execute(dynamic, new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
    expect(settle).toHaveBeenCalledWith(dynamic, expect.objectContaining({
      outputBytes: 8192, executionSeconds: 120, cleanupComplete: true, uncertain: true,
    }));
    expect(mountDockerHostStorage).not.toHaveBeenCalled();
  });

  test('unproved revocation cannot return success or claim completed cleanup', async () => {
    const dynamic = dynamicPlan();
    const executor = backend([agent], {
      resolveAgentAuthority: async () => binding, settleAgentAuthority: async () => ({ revoked: false }),
    });
    await expect(executor.execute(dynamic, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(docker.containers.size).toBe(0);
    await expect(executor.close()).rejects.toThrow('authority cleanup requires recovery');
  });

  test('dynamic entries cannot be launched without a trusted revocation hook', () => {
    dynamicPlan();
    expect(() => backend([agent], { resolveAgentAuthority: async () => binding })).toThrow('admission and revocation');
  });
});
