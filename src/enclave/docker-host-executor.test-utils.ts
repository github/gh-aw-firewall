import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { createDockerHostEnclaveExecutor, type DockerHostExecutorEntry } from './docker-host-executor';
import { expectedDockerHostContainer, type DockerHostCommand } from './docker-host-recovery';
import { mountDockerHostStorage, cleanupDockerHostStorage, ownDockerHostStorageFile } from './docker-host-storage';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { hasDockerHostMountCapability } from './docker-storage-helper';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';

// Import this module before the mocked dependencies in each test suite.
jest.mock('fs', () => ({ ...jest.requireActual('fs'), chownSync: jest.fn(), fchownSync: jest.fn() }));
jest.mock('./public-debug-artifacts', () => ({
  ...jest.requireActual('./public-debug-artifacts'), preservePublicEnclaveArtifacts: jest.fn(),
}));
jest.mock('./public-debug', () => ({
  ...jest.requireActual('./public-debug'), resolveDockerPublicEnclaveDebugPaths: jest.fn(),
}));
jest.mock('./docker-host-storage', () => ({
  ...jest.requireActual('./docker-host-storage'),
  mountDockerHostStorage: jest.fn(),
  cleanupDockerHostStorage: jest.fn(),
  ownDockerHostStorageFile: jest.fn(),
}));
jest.mock('./docker-storage-helper', () => ({
  ...jest.requireActual('./docker-storage-helper'),
  hasDockerHostMountCapability: jest.fn(() => true),
  dockerHelperStorageTarget: jest.fn((...args: string[]) =>
    jest.requireActual('./docker-storage-helper').dockerHelperStorageTarget(...args)),
}));

const realOwnDockerHostStorageFile = jest.requireActual<typeof import('./docker-host-storage')>('./docker-host-storage')
  .ownDockerHostStorageFile;

export const runId = 'a'.repeat(32);
export const invocationId = 'b'.repeat(32);
const seedId = 'c'.repeat(32);
export const MiB = 1024 ** 2;
export const describeLinux = process.platform === 'linux' ? describe : describe.skip;
export const binding = { repository: 'owner/private', githubBearer: 'short-lived-bearer-token', readMode: 'live' };

export class FakeDocker {
  calls: string[][] = [];
  containers = new Map<string, any>();
  serial = 1;
  failRemoval = false;
  pendingCreate = false;
  missingImage = false;
  holdWorkload = false;
  failProbe = false;
  outputValue = 'true';
  workloadExitCode = 0;
  network = 'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,';
  daemon: any = { OSType: 'linux', SecurityOptions: [] };
  onWorkloadStart?: () => void;

  command: DockerHostCommand = async (readonlyArgs) => {
    const args = [...readonlyArgs];
    this.calls.push(args);
    const ok = (stdout = '') => ({ exitCode: 0, stdout });
    if (args[0] === 'info') return ok(JSON.stringify(this.daemon));
    if (args[0] === 'network') return ok(this.network);
    if (args[0] === 'ps') {
      const filter = args.find((v) => v.startsWith('name=') || v.startsWith('id='));
      const invocation = args.find((v) => v.startsWith('label=awf.enclave.invocation='));
      return ok([...this.containers.values()].filter((c) =>
        (!filter || (filter.startsWith('id=') ? c.Id === filter.slice(3) : c.Name === filter.slice(7, -1)))
        && (!invocation || c.Config.Labels['awf.enclave.invocation'] === invocation.split('=').pop()))
        .map((c) => c.Id).join('\n'));
    }
    if (args[0] === 'create') {
      if (this.pendingCreate) return { exitCode: 1, stdout: '' };
      if (this.missingImage) return {
        exitCode: 1, stdout: '', imageUnavailable: args.find(value => value.startsWith('trusted/')),
      };
      const imageAt = args.findIndex(value => value.startsWith('trusted/'));
      const base = args.slice(0, imageAt + 1);
      const expected = expectedDockerHostContainer(base);
      const values = (flag: string) => base.filter((_, i) => base[i - 1] === flag);
      const id = String(this.serial++).padStart(64, '0');
      const inspected: any = {
        Id: id, Name: `/${expected.name}`,
        Config: {
          Image: expected.image, Entrypoint: [expected.entrypoint], Cmd: args.slice(imageAt + 1),
          User: expected.user, WorkingDir: expected.workdir, Hostname: expected.hostname,
          Labels: expected.labels, Env: values('--env'),
        },
        HostConfig: {
          NetworkMode: expected.network, ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
          CapAdd: values('--cap-add').map(cap => `CAP_${cap}`).sort(),
          SecurityOpt: expected.security, Memory: expected.memory, MemorySwap: expected.memory,
          NanoCpus: expected.cpus, PidsLimit: expected.pids, ShmSize: expected.shm,
          Runtime: expected.runtime || 'runc', LogConfig: { Type: 'none' }, AutoRemove: false,
          Binds: expected.binds, Tmpfs: expected.tmpfs, Ulimits: expected.ulimits,
        },
        Mounts: expected.binds.map((bind) => {
          const [Source, Destination, mode] = bind.split(':');
          return { Source, Destination, RW: mode === 'rw', Type: 'bind' };
        }),
        State: { Running: false, ExitCode: 0, Status: 'created' },
        NetworkSettings: { Networks: { [expected.network]: {} } },
      };
      this.containers.set(id, inspected);
      return ok(id);
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const found = this.containers.get(args[2]) || [...this.containers.values()].find((c) => c.Name === `/${args[2]}`);
      return found ? ok(JSON.stringify([found])) : { exitCode: 1, stdout: '' };
    }
    if (args[0] === 'start') {
      const current = this.containers.get(args[1]);
      current.State.Status = 'exited';
      if (current.Name.endsWith('-probe')) current.State.ExitCode = this.failProbe ? 1 : 0;
      else {
        const output = current.Mounts.find((m: any) => m.Destination === '/awf/out');
        fs.writeFileSync(output.Source, this.outputValue);
        current.State.Running = this.holdWorkload;
        if (this.holdWorkload) current.State.Status = 'running';
        current.State.ExitCode = this.workloadExitCode;
        this.onWorkloadStart?.();
      }
      return ok();
    }
    if (args[0] === 'kill') {
      this.containers.get(args[1]).State.Running = false;
      this.containers.get(args[1]).State.Status = 'exited';
      return ok();
    }
    if (args[0] === 'rm') {
      if (this.failRemoval) return { exitCode: 1, stdout: '' };
      this.containers.delete(args[2]);
      return ok();
    }
    throw new Error(`Unexpected fake Docker command: ${args[0]}`);
  };
}

export function useDockerHostExecutorFixture() {
  let root: string;
  let docker: FakeDocker;
  let plan: HostExecutorInvocationPlan;
  let script: DockerHostExecutorEntry;
  let agent: DockerHostExecutorEntry;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(preservePublicEnclaveArtifacts).mockReset().mockResolvedValue();
    jest.mocked(hasDockerHostMountCapability).mockReturnValue(true);
    jest.mocked(ownDockerHostStorageFile).mockReset().mockImplementation(realOwnDockerHostStorageFile);
    root = path.join(process.cwd(), `.docker-host-executor-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    jest.mocked(resolveDockerPublicEnclaveDebugPaths).mockReturnValue({
      protectedRoot: root, root: path.join(root, 'debug-artifacts', 'docker'),
    });
    fs.mkdirSync(path.join(root, 'seeds'), { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'seeds', seedId), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'seccomp.json'), '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
    docker = new FakeDocker();
    plan = {
      runId, invocationId, entryId: 'script', executorKind: 'script', timeoutMs: 1000,
      requestHash: 'd'.repeat(64), admissionId: 'e'.repeat(32), schemaHash: 'f'.repeat(64),
      schema: { type: 'boolean' }, payload: 'open("/query/out","w").write("true")',
      invocationHostDir: path.join(root, 'invocations', 'script', invocationId),
      seedId, seedHostPath: path.join(root, 'seeds', seedId),
    };
    script = {
      entryId: 'script', executorKind: 'script', hostWritableBytes: 64 * MiB, aggregateWritableBytes: 320 * MiB,
      config: {
        queryImage: 'trusted/script:custom', querySeccompPath: path.join(root, 'seccomp.json'),
        queryUid: 65534, queryGid: 65534,
        queryMountDir: '/query', queryScriptPath: '/awf/query-script.py',
        memoryLimit: '768m', cpuLimit: '0.5', pidsLimit: 47, tmpfsLimit: '96m',
      },
    };
    agent = {
      entryId: 'agent', executorKind: 'agent', hostWritableBytes: 64 * MiB, aggregateWritableBytes: 256 * MiB,
      config: {
        enclaveImage: 'trusted/agent:custom', enclaveSeccompPath: path.join(root, 'seccomp.json'),
        enclaveUid: 65534, enclaveGid: 65534,
        enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed', enclaveTaskPath: '/awf/task.txt',
        enclaveSchemaPath: '/awf/schema.json', enclaveGithubAgentIdPath: '/run/awf-enclave-github/agent-id',
        enclaveGithubBearerPath: '/run/awf-enclave-github/bearer',
        engine: 'copilot', profile: 'copilot', model: 'trusted-model',
        apiEndpoint: 'http://172.31.0.30:10002', network: 'awf-enclave-agent',
        memoryLimit: '768m', cpuLimit: '0.5', pidsLimit: 47, tmpfsLimit: '96m',
        timeoutSeconds: 120, maxOutputBytes: 8192, githubGatewayContainer: 'awmg-mcpg',
      },
    };
    jest.mocked(mountDockerHostStorage).mockImplementation(async (target, source, bytes) => {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.chmodSync(target, 0o700);
      return { mountId: '42', device: '0:42', root: '/', source, target, bytes };
    });
    jest.mocked(cleanupDockerHostStorage).mockImplementation(async (record) => {
      expect(docker.containers.size).toBe(0);
      fs.rmSync(record.storageTarget, { recursive: true, force: true });
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function backend(entries = [script], extras: Record<string, any> = {}) {
    return createDockerHostEnclaveExecutor({
      runId, journalDir: path.join(root, 'journal'), entries, dockerCommand: docker.command, ...extras,
    });
  }

  function dynamicPlan(): HostExecutorInvocationPlan {
    agent.config = { ...agent.config, dynamicEnabled: true, dynamicGithubMcpUrl: 'http://172.31.0.40/mcp' };
    docker.network += 'awmg-mcpg@172.31.0.40/24,';
    return { ...plan, entryId: 'agent', executorKind: 'agent', selector: 'owner/private', seedId: undefined, seedHostPath: undefined };
  }

  return () => ({ root, docker, plan, script, agent, backend, dynamicPlan });
}

export type DockerHostExecutorTestFixture = ReturnType<ReturnType<typeof useDockerHostExecutorFixture>>;
