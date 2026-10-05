import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CloudHypervisorApiClient } from '../../src/cloud-hypervisor/api-client';

const faults = require('./cloud-hypervisor-enclave-startup-faults') as {
  withStartupFault(
    storage: object, phase: string, capture: (socket: string) => Promise<void>,
    apiClient: typeof CloudHypervisorApiClient,
  ): { managerDependencies: { createClient(socket: string, timeout: number): CloudHypervisorApiClient } };
  assertAllocatedResources(resource: unknown, cleanup: unknown, run: string, invocation: string, pid: number): void;
  assertStartupCleanup(before: unknown, after: unknown, cleanup: unknown, exists: (file: string) => boolean): void;
};

describe('host-owned enclave startup faults', () => {
  it.each(['vmCreate', 'vmBoot'])('fails only after the real %s API exchange', async (phase) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-fault-'));
    const socket = path.join(directory, 'api.sock');
    const methods: string[] = [];
    const server = http.createServer((request, response) => {
      methods.push(request.url!);
      request.resume();
      if (request.url === '/api/v1/vmm.ping') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"53.0"}');
        return;
      }
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const capture = jest.fn(async (file: string) => {
        expect(file).toBe(socket);
        expect(methods).toContain(`/api/v1/vm.${phase === 'vmCreate' ? 'create' : 'boot'}`);
      });
      const close = jest.fn();
      const createRunPaths = jest.fn();
      const storage = { close, managerDependencies: { createRunPaths } };
      const faulted = faults.withStartupFault(storage, phase, capture, CloudHypervisorApiClient);
      expect(faulted).toMatchObject({ close, managerDependencies: { createRunPaths } });
      const client = faulted.managerDependencies.createClient(socket, 1000);
      if (phase === 'vmBoot') {
        await client.vmCreate({
          cpus: { boot_vcpus: 1, max_vcpus: 1 }, memory: { size: 512 * 1024 * 1024 },
          payload: { kernel: '/kernel' },
        });
        expect(capture).not.toHaveBeenCalled();
        await expect(client.vmBoot()).rejects.toThrow('Acceptance-only host startup fault');
      } else {
        await expect(client.vmCreate({
          cpus: { boot_vcpus: 1, max_vcpus: 1 }, memory: { size: 512 * 1024 * 1024 },
          payload: { kernel: '/kernel' },
        })).rejects.toThrow('Acceptance-only host startup fault');
      }
      expect(capture).toHaveBeenCalledTimes(1);
      await expect(client.ping()).resolves.toBeDefined();
      await expect(client.vmShutdown()).resolves.toBeUndefined();
      expect(methods).toContain('/api/v1/vm.shutdown');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const resource = {
    runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32), vmRunId: 'c'.repeat(32),
    owner: { pid: 42 }, state: 'pending', bootId: 'boot',
    directory: '/invocations/one', directoryIdentity: { device: '1', inode: '2' },
    ancestors: [], mount: { mountId: 3 }, snapshot: { path: '/storage/artifacts/run-one', identity: { inode: '4' } },
    storage: {
      directory: '/storage', mountedIdentity: { device: '5', inode: '6' },
      mounts: [{ mountPoint: '/storage', mountId: 7 }, { mountPoint: '/storage/artifacts/run-one', mountId: 8 }],
    },
  };
  const cleanup = {
    runId: resource.vmRunId, owner: { pid: 42 }, workload: { invocationId: resource.invocationId },
    identities: { runDirectory: { inode: '9' }, cgroup: { inode: '10' }, netns: { inode: '11' } },
    vmmIdentity: { uid: 1234 }, mounts: [{ mountId: 12 }],
    processes: { vmm: { state: 'live', identity: { pid: 43 } }, 'virtiofsd-one': { state: 'live', identity: { pid: 44 } } },
    paths: { runDirectory: '/storage/runs/vm', cgroupPath: '/cgroup/one', virtiofsdShareDirectory: '/storage/runs/fs' },
    network: { netnsPath: '/run/netns/one' },
  };
  it('requires real resource allocation evidence before injecting failure', () => {
    expect(() => faults.assertAllocatedResources(resource, cleanup, resource.runId, resource.invocationId, 42)).not.toThrow();
    for (const override of [{ state: 'cleaned' }, { owner: { pid: 99 } }, { mount: undefined }, { snapshot: undefined }]) {
      expect(() => faults.assertAllocatedResources({ ...resource, ...override }, cleanup,
        resource.runId, resource.invocationId, 42)).toThrow();
    }
    expect(() => faults.assertAllocatedResources(resource, { ...cleanup, processes: {} },
      resource.runId, resource.invocationId, 42)).toThrow();
  });
  it('requires identity-preserving cleanup, allowing only the explicitly released snapshot mount', () => {
    const after = {
      ...resource, state: 'cleaned',
      storage: { ...resource.storage, mounts: resource.storage.mounts.slice(0, 1) },
    };
    expect(() => faults.assertStartupCleanup(resource, after, cleanup, () => false)).not.toThrow();
    expect(() => faults.assertStartupCleanup(resource, resource, cleanup, () => false)).toThrow();
    expect(() => faults.assertStartupCleanup(resource, {
      ...after, directoryIdentity: { device: '99', inode: '99' },
    }, cleanup, () => false)).toThrow();
    expect(() => faults.assertStartupCleanup(resource, after, cleanup, () => true)).toThrow();
  });
  it('has no production entrypoint, workload-selectable control, or manager replacement', () => {
    const source = fs.readFileSync(path.join(__dirname, 'cloud-hypervisor-enclave-startup-faults.js'), 'utf8');
    expect(source).not.toMatch(/process\.env|createManager|DEVELOPMENT_ALLOW|allow.unattested/);
    expect(source).toContain('await super.vmCreate(config)');
    expect(source).toContain('await super.vmBoot()');
    expect(source).toContain('ProductionTrustedCloudHypervisorEnclaveStorageProvider');
    expect(source).toContain('createHostExecutorClient');
    expect(source).toContain('client.settle');
    expect(source).toContain('validateRecord(cleanup');
    expect(source).toContain('processMatches(processDependencies');
    expect(source).toContain('client.invoke(request)');
    expect(() => faults.withStartupFault({}, 'execute', async () => {}, CloudHypervisorApiClient)).toThrow();
  });
});
