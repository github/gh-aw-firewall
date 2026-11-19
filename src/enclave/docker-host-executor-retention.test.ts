import {
  describeLinux, useDockerHostExecutorFixture, runId, invocationId,
  type DockerHostExecutorTestFixture, type FakeDocker,
} from './docker-host-executor.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import { recoverDockerHostEnclaveExecutor, type DockerHostExecutorEntry } from './docker-host-executor';
import { DockerHostRecoveryJournal } from './docker-host-recovery';
import { mountDockerHostStorage, cleanupDockerHostStorage, ownDockerHostStorageFile } from './docker-host-storage';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { dockerHelperStorageTarget, hasDockerHostMountCapability } from './docker-storage-helper';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';
import { expectPublicEnclaveAdapterConformance } from './public-debug-conformance.test-utils';

describeLinux('host-owned Docker enclave executor retention and diagnostics', () => {
  const getFixture = useDockerHostExecutorFixture();
  let root: string;
  let docker: FakeDocker;
  let plan: HostExecutorInvocationPlan;
  let script: DockerHostExecutorEntry;
  let agent: DockerHostExecutorEntry;
  let backend: DockerHostExecutorTestFixture['backend'];

  beforeEach(() => {
    ({ root, docker, plan, script, agent, backend } = getFixture());
  });

  test('captures only public-enabled Docker invocations with log driver none before storage cleanup', async () => {
    let retained = false;
    jest.mocked(preservePublicEnclaveArtifacts).mockImplementation(async input => {
      expect(docker.containers.size).toBe(0);
      expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
      expect(input.envelope).toMatchObject({
        runtime: 'docker', runId, invocationId, stage: 'complete', failure: 'none', exitCode: 0,
      });
      expect(input.session.status).toBe('not-applicable');
      expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
      retained = true;
    });
    jest.mocked(cleanupDockerHostStorage).mockImplementation(async record => {
      expect(retained).toBe(true);
      fs.rmSync(record.storageTarget, { recursive: true, force: true });
    });
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'success', result: 'true' });
    const launch = docker.calls.filter(args => args[0] === 'create')[1];
    expect(launch).toEqual(expect.arrayContaining(['--log-driver', 'none', 'AWF_ENCLAVE_DEBUG_PUBLIC=true',
      `${plan.invocationHostDir}/stdout.log:/awf/stdout.log:rw`,
      `${plan.invocationHostDir}/stderr.log:/awf/stderr.log:rw`]));
    expect(docker.calls.some(args => args[0] === 'logs')).toBe(false);
  });

  test.each([false, undefined])('never stages capture files for publicDebug=%s', async publicDebug => {
    await backend([script], { publicDebug }).execute(plan, new AbortController().signal);
    expect(preservePublicEnclaveArtifacts).not.toHaveBeenCalled();
    expect(docker.calls.flat().some(value => value.includes('AWF_ENCLAVE_DEBUG_PUBLIC'))).toBe(false);
  });

  test.each(['exit', 'exception', 'setup'] as const)('retains %s failure with correct workload exit provenance', async failure => {
    if (failure === 'exit') docker.workloadExitCode = 23;
    if (failure === 'exception') {
      const command = docker.command;
      docker.command = async (args, signal) => {
        if (args[0] === 'start' && !docker.containers.get(args[1])!.Name.endsWith('-probe')) throw new Error('private exception');
        return command(args, signal);
      };
    }
    if (failure === 'setup') docker.failProbe = true;
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({
        exitCode: failure === 'exit' ? 23 : null,
        failure: failure === 'exit' ? 'workload-exit' : failure === 'exception' ? 'execution-exception' : 'setup-failed',
      }),
    }));
    const envelope = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0].envelope;
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(envelope.primaryFailure).toMatchObject({
      stage: failure === 'exit' ? 'workload-exit' : failure === 'exception' ? 'workload-start' : 'storage-probe',
    });
  });

  test('cleans helper-backed storage after a setup failure with missing capture files', async () => {
    jest.mocked(hasDockerHostMountCapability).mockReturnValue(false);
    jest.mocked(dockerHelperStorageTarget).mockReturnValue(plan.invocationHostDir);
    jest.mocked(ownDockerHostStorageFile).mockImplementation(async (_identity, name, _uid, _gid, reclaim) => {
      if (reclaim && ['stdout.log', 'stderr.log', 'session.jsonl'].includes(name)) {
        throw Object.assign(new Error('missing helper capture'), { code: 'ENOENT' });
      }
    });
    docker.failProbe = true;

    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure' });

    expect(cleanupDockerHostStorage).toHaveBeenCalledTimes(1);
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      stdout: { status: 'missing' }, stderr: { status: 'missing' },
    }));
    expect(new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()).toEqual([]);
  });

  test('successful retention retry records custody while preserving cleanup failure for recovery', async () => {
    jest.mocked(preservePublicEnclaveArtifacts).mockRejectedValueOnce(new Error('retention failed'));
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'executor-failure', cleanupComplete: false });
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    expect(journal.records()[0].publicDebug).toMatchObject({
      pending: false, retained: true, cleanupFailure: { category: 'retention-failed' },
    });
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledTimes(2);
    expect(jest.mocked(preservePublicEnclaveArtifacts).mock.calls[1][0].envelope).toMatchObject({
      stage: 'retention', failure: 'retention-failed', exitCode: 0,
      cleanupFailure: { stage: 'cleanup', category: 'retention-failed' },
    });
    jest.mocked(preservePublicEnclaveArtifacts).mockResolvedValue();
    await recoverDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries: [script], dockerCommand: docker.command,
      publicDebug: true,
    });
    expect(preservePublicEnclaveArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({
      stdout: { status: 'missing' }, stderr: { status: 'missing' }, session: { status: 'not-applicable' },
    }));
    expect(journal.records()).toEqual([]);
  });

  test('failed retention retry preserves pending source and rejects credential-free recovery', async () => {
    jest.mocked(preservePublicEnclaveArtifacts).mockRejectedValue(new Error('retention failed'));
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'executor-failure', cleanupComplete: false });
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    expect(journal.records()[0].publicDebug).toMatchObject({ pending: true });
    expect(journal.records()[0].publicDebug?.retained).not.toBe(true);
    jest.mocked(preservePublicEnclaveArtifacts).mockClear().mockResolvedValue();
    await expect(recoverDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries: [script], dockerCommand: docker.command,
      publicDebug: true,
    })).rejects.toThrow(/trusted recovery/);
    expect(preservePublicEnclaveArtifacts).not.toHaveBeenCalled();
    expect(journal.records()).toHaveLength(1);
  });

  test('pending stale public diagnostics do not block an unrelated run or lose their source', async () => {
    jest.mocked(preservePublicEnclaveArtifacts).mockRejectedValue(new Error('retention failed'));
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    record.owner.bootId = '00000000-0000-0000-0000-000000000000';
    journal.write(record);
    const nextRun = 'd'.repeat(32);
    const nextInvocation = 'e'.repeat(32);
    const executor = backend([script], { runId: nextRun });
    await expect(executor.execute({
      ...plan, runId: nextRun, invocationId: nextInvocation,
      invocationHostDir: path.join(root, 'invocations', 'script', nextInvocation),
    }, new AbortController().signal)).resolves.toEqual({ outcome: 'success', result: 'true' });
    await executor.close!();
    expect(fs.existsSync(record.storageTarget)).toBe(true);
    expect(journal.records()).toEqual([record]);
  });

  test('redaction secrets exclude numeric token budgets and bearer paths', async () => {
    agent.config = {
      ...agent.config, maxModelTokens: 128, syntheticToken: 'fixture-credential',
      openaiApiKey: 'fixture-openai-capability',
      modelBudgetSecret: 'fixture-budget-capability',
    };
    await backend([agent], { publicDebug: true }).execute({
      ...plan, entryId: 'agent', executorKind: 'agent',
    }, new AbortController().signal);
    const { secrets } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expect(secrets).toContain('fixture-credential');
    expect(secrets).toContain('fixture-openai-capability');
    expect(secrets).toContain('fixture-budget-capability');
    expect(secrets).not.toContain('128');
    expect(secrets).not.toContain(agent.config.enclaveGithubBearerPath);
  });

  test('reconciles stale pending-create identity before removal across repeated unrelated startups', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    record.owner.bootId = '00000000-0000-0000-0000-000000000000';
    record.createPending = true;
    delete record.containerId;
    journal.write(record);
    docker.failRemoval = false;
    for (const nextRun of ['d'.repeat(32), 'e'.repeat(32)]) {
      const executor = backend([script], { runId: nextRun });
      await executor.prepare!();
      await executor.close!();
      expect(fs.existsSync(record.storageTarget)).toBe(true);
      expect(journal.records()[0]).toMatchObject({
        createPending: false, containerId: expect.stringMatching(/^[a-f0-9]{64}$/),
        publicDebug: { pending: true },
      });
    }
    expect(docker.containers.size).toBe(0);
  });

  test('already-retained stale diagnostics allow unrelated storage cleanup without re-export', async () => {
    jest.mocked(preservePublicEnclaveArtifacts).mockRejectedValueOnce(new Error('retention failed'));
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const record = journal.records()[0];
    expect(record.publicDebug?.retained).toBe(true);
    record.owner.bootId = '00000000-0000-0000-0000-000000000000';
    journal.write(record);
    jest.mocked(preservePublicEnclaveArtifacts).mockClear();
    const executor = backend([script], { runId: 'd'.repeat(32) });
    await executor.prepare!();
    await executor.close!();
    expect(preservePublicEnclaveArtifacts).not.toHaveBeenCalled();
    expect(journal.records()).toEqual([]);
    expect(fs.existsSync(record.storageTarget)).toBe(false);
  });

  test('records observed nonzero exit before a cleanup failure', async () => {
    docker.workloadExitCode = 23;
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toMatchObject({ cleanupComplete: false });
    const record = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0];
    expect(record.publicDebug).toMatchObject({
      stage: 'execution', failure: 'workload-exit', exitCode: 23,
      primaryFailure: { stage: 'workload-exit', category: 'workload-exit' },
      cleanupFailure: { stage: 'cleanup' },
    });
  });

  test('never records a created-but-unstarted container default exit as workload evidence', async () => {
    const command = docker.command;
    docker.command = async (args, signal) => {
      if (args[0] === 'start' && !docker.containers.get(args[1])!.Name.endsWith('-probe')) {
        throw new Error('start failed');
      }
      return command(args, signal);
    };
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    const { envelope } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expect(envelope.exitCode).toBeNull();
    expect(envelope.dockerState?.exitCode).toBeNull();
  });

  test('never reads public artifacts before proved container removal and rejects runtime scope', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toMatchObject({ cleanupComplete: false });
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
      envelope: expect.objectContaining({ workloadStopped: false, cleanupFailure: { stage: 'cleanup', category: 'host-exception' } }),
    }));
    expect(() => backend([{ ...script, runtimeName: 'runsc' }], { publicDebug: true })).toThrow(/default-runtime/);
  });
  test('retains fixed authority failures before storage exists without synthesizing a stop or exit', async () => {
    const authority = jest.fn().mockRejectedValue(Object.assign(new Error('PRIVATE_AUTHORITY'), { code: 'EACCES' }));
    await expect(backend([agent], { publicDebug: true, resolveAgentAuthority: authority }).execute({
      ...plan, entryId: 'agent', executorKind: 'agent',
    }, new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
    expect(mountDockerHostStorage).not.toHaveBeenCalled();
    expect(docker.calls.some(args => args[0] === 'create')).toBe(false);
    const input = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
    expect(input.envelope).toMatchObject({
      workloadLaunched: false, exitCode: null,
      primaryFailure: { stage: 'authority-handoff', category: 'permission-denied', errno: 13 },
    });
    expect(JSON.stringify(input.envelope)).not.toContain('PRIVATE_AUTHORITY');
    expect(input.envelope.stages?.filter(event => event.status === 'failed')).toEqual([
      { stage: 'authority-handoff', status: 'failed', category: 'permission-denied', errno: 13 },
    ]);
  });

  test.each([
    ['EACCES', 'permission-denied', 13], ['ENOSPC', 'no-space', 28], ['EROFS', 'read-only-filesystem', 30],
  ])('retains %s storage failures before releasing even an empty invocation source', async (code, category, errno) => {
    jest.mocked(mountDockerHostStorage).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_STORAGE'), { code }));
    let retained = false;
    jest.mocked(preservePublicEnclaveArtifacts).mockImplementation(async input => {
      expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
      expect(input.stdout).toEqual({ status: 'unavailable' });
      expect(input.stderr).toEqual({ status: 'unavailable' });
      expect(input.session).toEqual({ status: 'not-applicable' });
      expect(input.envelope).toMatchObject({
        stage: 'setup', failure: 'setup-failed', workloadLaunched: false, exitCode: null,
        primaryFailure: { stage: 'storage-preparation', category, errno },
      });
      expect(input.envelope.dockerState).toBeUndefined();
      expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
      expect(JSON.stringify(input.envelope)).not.toContain('PRIVATE_STORAGE');
      retained = true;
    });
    jest.mocked(cleanupDockerHostStorage).mockImplementation(async () => { expect(retained).toBe(true); });
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure' });
    expect(docker.calls.some(args => args[0] === 'create')).toBe(false);
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledTimes(1);
    expect(new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()).toEqual([]);
  });

  test.each([
    ['seccomp.json', 'storage-preparation', 0], ['out', 'authority-handoff', 1], ['script.py', 'authority-handoff', 1],
  ])('retains pre-workload %s staging failures without using absent files as launch evidence', async (name, stage, creates) => {
    const executor = backend([script], { publicDebug: true });
    const mutableFs = jest.requireMock<typeof fs>('fs');
    const write = mutableFs.writeFileSync;
    const failedWrite = jest.spyOn(mutableFs, 'writeFileSync').mockImplementation((...args) => {
      if (args[0] === path.join(plan.invocationHostDir, String(name))) {
        throw Object.assign(new Error('PRIVATE_STAGING'), { code: 'ENOSPC' });
      }
      return write(...args);
    });
    try {
      await expect(executor.execute(plan, new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
    } finally { failedWrite.mockRestore(); }
    const input = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
    expect(input.envelope).toMatchObject({
      stage: 'setup', failure: 'setup-failed', workloadLaunched: false, exitCode: null,
      primaryFailure: { stage, category: 'no-space', errno: 28 },
    });
    expect(input.envelope.dockerState).toBeUndefined();
    expect(input.envelope.stages).not.toContainEqual({ stage: 'workload-create', status: 'started' });
    expect(JSON.stringify(input.envelope)).not.toContain('PRIVATE_STAGING');
    expect(docker.calls.filter(args => args[0] === 'create')).toHaveLength(Number(creates));
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
  });

  test('retains static authority-file validation failures before workload creation', async () => {
    agent.config = { ...agent.config, githubEnabled: true };
    await expect(backend([agent], {
      publicDebug: true,
      resolveAgentAuthority: async () => ({ githubAgentId: 'PRIVATE_INVALID_ID', repository: 'trusted/public' }),
    }).execute({ ...plan, entryId: 'agent', executorKind: 'agent' }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure' });
    const input = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
    expect(input.envelope).toMatchObject({
      workloadLaunched: false, exitCode: null,
      primaryFailure: { stage: 'authority-handoff', category: 'host-exception' },
    });
    expect(docker.calls.filter(args => args[0] === 'create')).toHaveLength(1);
    expect(JSON.stringify(input.envelope)).not.toContain('PRIVATE_INVALID_ID');
  });

  test('retains network preflight failures without promoting the storage probe exit to workload evidence', async () => {
    docker.network += 'awf-primary@172.31.0.20/24,';
    await expect(backend([agent], { publicDebug: true }).execute({
      ...plan, entryId: 'agent', executorKind: 'agent',
    }, new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
    const { envelope } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(envelope).toMatchObject({
      workloadLaunched: false, exitCode: null,
      primaryFailure: { stage: 'network-isolation', category: 'host-exception' },
    });
    expect(envelope.dockerState).toBeUndefined();
    expect(docker.calls.filter(args => args[0] === 'create')).toHaveLength(1);
  });

  test('promotes bounded stderr startup failure while retaining truthful missing-session coverage', async () => {
    docker.workloadExitCode = 1;
    docker.onWorkloadStart = () => {
      fs.unlinkSync(path.join(plan.invocationHostDir, 'session.jsonl'));
      fs.writeFileSync(path.join(plan.invocationHostDir, 'stderr.log'), `${JSON.stringify({
        event: 'operation-error', operation: 'session-log-open',
        category: 'permission-denied', errno: 13, fatal: true, message: 'PRIVATE_STARTUP',
      })}\n`);
    };
    await expect(backend([agent], { publicDebug: true }).execute({
      ...plan, entryId: 'agent', executorKind: 'agent',
    }, new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
    const { envelope, session } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(session).toEqual({ status: 'missing' });
    expect(envelope).toMatchObject({
      workloadLaunched: true, exitCode: 1,
      primaryFailure: { stage: 'entrypoint-initialization', operation: 'session-log-open', category: 'permission-denied', errno: 13 },
    });
    expect(envelope.stages).toContainEqual({
      stage: 'entrypoint-initialization', status: 'failed', operation: 'session-log-open', category: 'permission-denied', errno: 13,
    });
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_STARTUP');
  });

  test('retains only host evidence when capture-file ownership fails, leaving the recovery source protected', async () => {
    docker.onWorkloadStart = () => {
      fs.writeFileSync(path.join(plan.invocationHostDir, 'stdout.log'), 'PRIVATE_UNRECLAIMED_STREAM');
      jest.mocked(fs.fchownSync).mockImplementation(fd => {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/stdout.log')) {
          throw Object.assign(new Error('PRIVATE_OWNERSHIP'), { code: 'EPERM' });
        }
      });
    };
    try {
      await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    } finally { jest.mocked(fs.fchownSync).mockReset(); }
    const input = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
    expect(input).toMatchObject({
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'not-applicable' },
      envelope: {
        workloadLaunched: true, exitCode: 0,
        cleanupFailure: { stage: 'cleanup', category: 'operation-not-permitted', errno: 1 },
      },
    });
    expect(JSON.stringify(input.envelope)).not.toContain('PRIVATE_OWNERSHIP');
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(docker.containers.size).toBe(0);
    expect(fs.readFileSync(path.join(plan.invocationHostDir, 'stdout.log'), 'utf8')).toBe('PRIVATE_UNRECLAIMED_STREAM');
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    expect(journal.records()[0].publicDebug).toMatchObject({ pending: true });
    expect(journal.records()[0].publicDebug?.retained).not.toBe(true);
    await expect(recoverDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries: [script], dockerCommand: docker.command,
      publicDebug: true,
    })).rejects.toThrow(/trusted recovery/);
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
  });

  test('updates retained host evidence on storage cleanup failure without releasing its source', async () => {
    jest.mocked(cleanupDockerHostStorage).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_UNMOUNT'), { code: 'EIO' }));
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledTimes(2);
    const { envelope } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[1][0];
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(envelope).toMatchObject({
      exitCode: 0, workloadLaunched: true, cleanupFailure: { stage: 'cleanup', category: 'io-error', errno: 5 },
    });
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_UNMOUNT');
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
    expect(new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()[0].publicDebug)
      .toMatchObject({ pending: false, retained: true });
  });

  test.each([false, true])('boundedly retries pre-storage retention failures (persistent=%s)', async persistent => {
    const retain = jest.mocked(preservePublicEnclaveArtifacts);
    if (persistent) retain.mockRejectedValue(new Error('PRIVATE_RETENTION'));
    else retain.mockRejectedValueOnce(new Error('PRIVATE_RETENTION'));
    await expect(backend([agent], {
      publicDebug: true,
      resolveAgentAuthority: async () => { throw Object.assign(new Error('PRIVATE_AUTHORITY'), { code: 'EACCES' }); },
    }).execute({ ...plan, entryId: 'agent', executorKind: 'agent' }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(retain).toHaveBeenCalledTimes(2);
    const { envelope } = retain.mock.calls[1][0];
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(envelope).toMatchObject({
      stage: 'retention', failure: 'retention-failed', workloadLaunched: false, exitCode: null,
      primaryFailure: { stage: 'authority-handoff', category: 'permission-denied', errno: 13 },
      cleanupFailure: { stage: 'cleanup', category: 'retention-failed' },
    });
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE_RETENTION');
    expect(mountDockerHostStorage).not.toHaveBeenCalled();
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
  });

  test.each([undefined, 'EACCES'])('retains finite unavailable initialization metadata without stop proof (code=%s)', async code => {
    const command = docker.command;
    docker.command = async (args, signal) => {
      if (args[0] === 'info') {
        if (code) throw Object.assign(new Error('PRIVATE_INITIALIZATION'), { code });
        return { exitCode: 1, stdout: '' };
      }
      return command(args, signal);
    };
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
    expect(preservePublicEnclaveArtifacts).not.toHaveBeenCalled();
    expect(mountDockerHostStorage).not.toHaveBeenCalled();
    const directory = path.join(root, 'debug-artifacts', 'docker', runId, invocationId);
    expect(fs.readdirSync(directory)).toEqual(['retention-unavailable.json']);
    const contents = fs.readFileSync(path.join(directory, 'retention-unavailable.json'), 'utf8');
    const metadata = JSON.parse(contents);
    expect(metadata).toMatchObject({
      version: 1, runId, invocationId, entryId: 'script', executorKind: 'script', runtime: 'docker',
      stage: 'setup', status: 'unavailable', reason: 'host-reconciliation-incomplete',
      primaryFailure: {
        stage: 'storage-preparation', category: code ? 'permission-denied' : 'host-exception',
        ...(code ? { errno: 13 } : {}),
      },
    });
    expect(metadata.stages.length).toBeLessThanOrEqual(64);
    expect(metadata).not.toHaveProperty('workloadStopped');
    expect(metadata).not.toHaveProperty('workloadLaunched');
    expect(metadata).not.toHaveProperty('exitCode');
    expect(metadata).not.toHaveProperty('streams');
    expect(contents).not.toContain('PRIVATE_INITIALIZATION');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, 'retention-unavailable.json')).mode & 0o777).toBe(0o600);
  });

  test('unreconciled initialization retains only host metadata and never releases the earlier workload source', async () => {
    docker.onWorkloadStart = () => {
      docker.failRemoval = true;
      fs.writeFileSync(path.join(plan.invocationHostDir, 'stdout.log'), 'PRIVATE_UNRECONCILED_SOURCE');
    };
    await backend([script], { publicDebug: true }).execute(plan, new AbortController().signal);
    const journal = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId);
    const records = journal.records();
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
      envelope: expect.objectContaining({
        workloadStopped: false, cleanupFailure: { stage: 'cleanup', category: 'host-exception' },
      }),
    }));
    expect(journal.records()).toEqual(records);
    expect(fs.readFileSync(path.join(plan.invocationHostDir, 'stdout.log'), 'utf8')).toBe('PRIVATE_UNRECONCILED_SOURCE');
    const metadataDirectory = path.join(root, 'debug-artifacts', 'docker', runId, invocationId);
    expect(fs.readdirSync(metadataDirectory)).toEqual(['retention-unavailable.json']);
    const metadata = fs.readFileSync(path.join(metadataDirectory, 'retention-unavailable.json'), 'utf8');
    expect(JSON.parse(metadata)).toMatchObject({
      status: 'unavailable', reason: 'host-reconciliation-incomplete',
      primaryFailure: { stage: 'storage-preparation', category: 'host-exception' },
    });
    expect(metadata).not.toContain('PRIVATE_UNRECONCILED_SOURCE');
    expect(JSON.parse(metadata)).not.toHaveProperty('workloadStopped');
    expect(JSON.parse(metadata)).not.toHaveProperty('workloadLaunched');
  });

  test('boundedly retries unavailable-metadata persistence with fixed cleanup failure provenance', async () => {
    const command = docker.command;
    docker.command = async (args, signal) => args[0] === 'info'
      ? { exitCode: 1, stdout: '' } : command(args, signal);
    const metadataPath = path.join(root, 'debug-artifacts', 'docker', runId, invocationId, 'retention-unavailable.json');
    const open = fs.promises.open;
    let writes = 0;
    const failedOpen = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[0] === metadataPath && writes++ === 0) {
        throw Object.assign(new Error('PRIVATE_METADATA_WRITE'), { code: 'EIO' });
      }
      return open(...args);
    });
    try {
      await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    } finally { failedOpen.mockRestore(); }
    expect(writes).toBe(2);
    const contents = fs.readFileSync(metadataPath, 'utf8');
    expect(JSON.parse(contents)).toMatchObject({
      status: 'unavailable', reason: 'host-reconciliation-incomplete',
      primaryFailure: { stage: 'storage-preparation', category: 'host-exception' },
      cleanupFailure: { stage: 'cleanup', category: 'io-error', errno: 5 },
    });
    expect(contents).not.toContain('PRIVATE_METADATA_WRITE');
    expect(preservePublicEnclaveArtifacts).not.toHaveBeenCalled();
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
  });

  test('retains definitive missing-image setup failure only after proved absence, not unresolved creates', async () => {
    docker.missingImage = true;
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure' });
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
    const input = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(input.envelope, 'docker');
    expect(input.envelope).toMatchObject({
      stage: 'setup', failure: 'setup-failed', exitCode: null, workloadLaunched: false,
      primaryFailure: { stage: 'storage-probe', category: 'not-found', errno: 2 },
    });
    expect(new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records()).toEqual([]);
    docker.missingImage = false;
    docker.pendingCreate = true;
    jest.mocked(preservePublicEnclaveArtifacts).mockClear();
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toMatchObject({ cleanupComplete: false });
    expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({
        workloadStopped: false, workloadLaunched: false, exitCode: null,
        primaryFailure: { stage: 'storage-probe', category: 'host-exception' },
        cleanupFailure: { stage: 'cleanup', category: 'cleanup-failed' },
      }),
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
    }));
    expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
  });

  test('a definitively absent workload image is not a launch even when invocation capture files exist', async () => {
    const command = docker.command;
    docker.command = async (args, signal) => {
      if (args[0] === 'create' && args[args.indexOf('--name') + 1]?.endsWith(invocationId)) docker.missingImage = true;
      return command(args, signal);
    };
    await expect(backend([script], { publicDebug: true }).execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure' });
    const { envelope } = jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0];
    expectPublicEnclaveAdapterConformance(envelope, 'docker');
    expect(envelope).toMatchObject({
      stage: 'setup', failure: 'setup-failed', workloadLaunched: false, exitCode: null,
      primaryFailure: { stage: 'workload-create', category: 'not-found', errno: 2 },
    });
    expect(docker.calls.filter(args => args[0] === 'start')).toHaveLength(1);
    expect(fs.existsSync(plan.invocationHostDir)).toBe(false);
  });

  describe.each(['copilot', 'codex', 'claude'])('%s supervisor lifecycle', engine => {
    function agentPlan(): HostExecutorInvocationPlan {
      agent.config = { ...agent.config, engine };
      return { ...plan, entryId: 'agent', executorKind: 'agent' };
    }

    test.each(['probe', 'exit', 'retention', 'removal'] as const)(
      'preserves the first failure and verified/uncertain cleanup for %s', async phase => {
        const invocation = agentPlan();
        if (phase === 'probe') docker.failProbe = true;
        else docker.workloadExitCode = 23;
        if (phase === 'retention') jest.mocked(preservePublicEnclaveArtifacts).mockRejectedValue(new Error('PRIVATE_RETENTION'));
        if (phase === 'removal') docker.onWorkloadStart = () => { docker.failRemoval = true; };
        const executor = backend([agent], { publicDebug: true });
        const result = await executor.execute(invocation, new AbortController().signal);
        expect(result.outcome).toBe('executor-failure');
        expect(result).not.toHaveProperty('result');
        const uncertain = phase === 'retention' || phase === 'removal';
        expect(result.cleanupComplete === false).toBe(uncertain);
        expect(fs.existsSync(invocation.invocationHostDir)).toBe(uncertain);
        const records = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records();
        expect(records).toHaveLength(uncertain ? 1 : 0);
        const expectedFailure = { stage: phase === 'probe' ? 'storage-probe' : 'workload-exit' };
        if (uncertain) {
          expect(records[0].publicDebug?.primaryFailure).toMatchObject(expectedFailure);
          expect(records[0].publicDebug?.cleanupFailure).toBeDefined();
          expect(records[0].publicDebug?.pending).toBe(true);
          await expect(executor.close()).rejects.toThrow(/recovery/);
        } else {
          expect(jest.mocked(preservePublicEnclaveArtifacts).mock.calls[0][0].envelope.primaryFailure)
            .toMatchObject(expectedFailure);
          expect(docker.containers.size).toBe(0);
          await expect(executor.close()).resolves.toBeUndefined();
        }
      });
  });

  test('failed removal retains both tmpfs and durable journal, with no approved result', async () => {
    docker.onWorkloadStart = () => { docker.failRemoval = true; };
    const executor = backend();
    await expect(executor.execute(plan, new AbortController().signal))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    const [record] = new DockerHostRecoveryJournal(path.join(root, 'journal'), runId).records();
    expect(record.containerId).toMatch(/^[0-9a-f]{64}$/);
    expect(record.expected?.image).toBe('trusted/script:custom');
  });
});
