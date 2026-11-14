import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { createDockerHostContext, type DockerHostContext } from './docker-host-context';
import { createDockerHostContainerOperations } from './docker-host-container';
import { expectedDockerHostContainer, type DockerHostRecoveryRecord } from './docker-host-recovery';
import { cleanupDockerHostStorage } from './docker-host-storage';
import { PublicEnclaveOperationRecorder } from './public-debug-events';

jest.mock('./docker-host-storage', () => ({
  ...jest.requireActual('./docker-host-storage'), cleanupDockerHostStorage: jest.fn(),
}));

const runId = 'a'.repeat(32);
const invocationId = 'b'.repeat(32);
const containerId = 'c'.repeat(64);
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('Docker host container operations', () => {
  let root: string;
  let context: DockerHostContext;
  let docker: jest.MockedFunction<DockerHostContext['docker']>;
  let record: DockerHostRecoveryRecord;
  const args = [
    'run', '--name', 'awf-enclave-script-script-test', '--entrypoint', '/runner',
    '--user', '65534:65534', '--network', 'none', '--memory', '64m', '--cpus', '0.5',
    '--pids-limit', '32', '--label', `awf.enclave.run=${runId}`,
    '--label', `awf.enclave.invocation=${invocationId}`, 'trusted/script:test',
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    root = path.join(process.cwd(), `.docker-host-container-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    docker = jest.fn().mockResolvedValue({ exitCode: 0, stdout: '' });
    context = createDockerHostContext({ runId, journalDir: path.join(root, 'journal'), entries: [], dockerCommand: docker });
    record = {
      version: 1, runId, invocationId, entryId: 'script', owner: context.owner,
      storageTarget: path.join(root, invocationId),
      storageSource: `awf-enclave-${runId}-script-${invocationId}`, storageBytes: 64 * 1024 ** 2,
    };
    context.journal.write(record);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function inspected(command: string[] = [], exitCode = 0) {
    const expected = expectedDockerHostContainer(args);
    return {
      Id: containerId, Name: `/${expected.name}`,
      Config: {
        Image: expected.image, Entrypoint: [expected.entrypoint], Cmd: command, User: expected.user,
        WorkingDir: expected.workdir, Hostname: expected.hostname, Labels: expected.labels, Env: [],
      },
      HostConfig: {
        NetworkMode: expected.network, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: [],
        SecurityOpt: expected.security, Memory: expected.memory, MemorySwap: expected.memory,
        NanoCpus: expected.cpus, PidsLimit: expected.pids, ShmSize: expected.shm, Runtime: 'runc',
        LogConfig: { Type: 'none' }, Binds: expected.binds, Tmpfs: expected.tmpfs, Ulimits: expected.ulimits,
      },
      NetworkSettings: { Networks: { none: {} } }, Mounts: [],
      State: { Running: false, ExitCode: exitCode, OOMKilled: false, Status: 'exited' },
    };
  }

  test('lists only validated immutable IDs with the existing label filters', async () => {
    const containers = createDockerHostContainerOperations(context);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: `${containerId}\n` });
    await expect(containers.labelledIds(invocationId)).resolves.toEqual([containerId]);
    expect(docker).toHaveBeenCalledWith([
      'ps', '-aq', '--no-trunc', '--filter', `label=awf.enclave.run=${runId}`,
      '--filter', `label=awf.enclave.invocation=${invocationId}`,
    ]);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: 'untrusted-name' });
    await expect(containers.labelledIds()).rejects.toThrow('Invalid immutable');
    docker.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(containers.labelledIds()).rejects.toThrow('reconciliation failed');
  });

  test('journals create intent before the daemon call and commits only inspected identity', async () => {
    const command = ['--probe'];
    docker.mockImplementation(async values => {
      if (values[0] === 'create') {
        expect(context.journal.records()[0]).toMatchObject({
          createPending: true, expected: { command, name: 'awf-enclave-script-script-test' },
        });
        return { exitCode: 0, stdout: containerId };
      }
      return { exitCode: 0, stdout: JSON.stringify([inspected(command)]) };
    });
    await expect(createDockerHostContainerOperations(context).createContainer(record, args, command)).resolves.toBe(containerId);
    expect(context.journal.records()[0]).toMatchObject({ createPending: false, containerId });
    expect(docker).toHaveBeenNthCalledWith(1, ['create', ...args.slice(1), ...command]);
  });

  test('keeps pending intent after uncertain create and reconciles it before cleanup', async () => {
    docker.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    const containers = createDockerHostContainerOperations(context);
    await expect(containers.createContainer(record, args)).rejects.toThrow('creation failed');
    expect(context.journal.records()[0].createPending).toBe(true);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([inspected()]) });
    await containers.reconcileCreate(record);
    expect(context.journal.records()[0]).toMatchObject({ createPending: false, containerId });
  });

  test('clears intent only for a definitive missing image with proven absence', async () => {
    docker.mockResolvedValueOnce({ exitCode: 1, stdout: '', imageUnavailable: 'trusted/script:test' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(createDockerHostContainerOperations(context).createContainer(record, args)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(context.journal.records()[0].createPending).toBe(false);
  });

  test('reports launch before start and records the inspected exit', async () => {
    record.expected = expectedDockerHostContainer(args);
    const launched = jest.fn(() => expect(docker).not.toHaveBeenCalled());
    const exited = jest.fn();
    const diagnostic = new PublicEnclaveOperationRecorder();
    const signal = new AbortController().signal;
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([inspected([], 7)]) });
    await expect(createDockerHostContainerOperations(context).runContainer(
      record, containerId, signal, launched, diagnostic, exited,
    )).resolves.toBe(7);
    expect(launched).toHaveBeenCalledTimes(1);
    expect(exited).toHaveBeenCalledWith({ running: false, exitCode: 7, oomKilled: false });
    expect(diagnostic.events.map(event => event.stage)).toEqual(['workload-start', 'workload-exit']);
  });

  test('does not launch an already cancelled invocation', async () => {
    const controller = new AbortController();
    controller.abort();
    const launched = jest.fn();
    await expect(createDockerHostContainerOperations(context).runContainer(
      record, containerId, controller.signal, launched,
    )).rejects.toThrow('cancelled before start');
    expect(docker).not.toHaveBeenCalled();
    expect(launched).not.toHaveBeenCalled();
  });

  test('requires an empty labelled resource set before storage and journal removal', async () => {
    const containers = createDockerHostContainerOperations(context);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: containerId });
    await expect(containers.cleanup(record)).rejects.toThrow('containers remain');
    expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
    expect(context.journal.records()).toHaveLength(1);
    jest.mocked(cleanupDockerHostStorage).mockImplementationOnce(async () => {
      expect(context.journal.records()).toHaveLength(1);
    });
    await containers.cleanup(record);
    expect(cleanupDockerHostStorage).toHaveBeenCalledWith(record);
    expect(context.journal.records()).toEqual([]);
  });
});
