import * as path from 'path';
import type { MicrovmNetworkPlan } from '../microvm/network';
import { requireNetwork } from './cleanup-network-state';
import { captureProcessIdentity } from './cleanup-process-identity';
import type {
  NvxCleanupDeviceAclIdentity,
  NvxCleanupFileIdentity,
  NvxCleanupInterfaceIdentity,
  NvxCleanupProcessIdentity,
  NvxCleanupRecord,
} from './cleanup-record';
import type { NvxCleanupRegistryDependencies } from './cleanup-registry';
import type { NvxRunLayout } from './run-layout';
import type { NvxVmmIdentity } from './runtime-lifecycle';

export async function captureArtifactSnapshot(
  record: NvxCleanupRecord,
  layout: NvxRunLayout,
  directory: string,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat'>,
): Promise<void> {
  if (path.resolve(directory) !== layout.artifactSnapshotDirectory) {
    throw new Error('NVX artifact snapshot is outside the run layout');
  }
  record.resources.artifactSnapshot = await captureFile(directory, dependencies);
  record.stages.artifactSnapshotCreated = true;
}

export function prepareAccount(record: NvxCleanupRecord, name: string): void {
  if (record.vmmIdentity) throw new Error('NVX cleanup account is already prepared');
  record.vmmIdentity = { state: 'pending', name };
}

export function captureIdentity(record: NvxCleanupRecord, identity: NvxVmmIdentity): void {
  if (record.vmmIdentity?.state !== 'pending' || record.vmmIdentity.name !== identity.name) {
    throw new Error('NVX cleanup account does not match its pending identity');
  }
  record.vmmIdentity = { state: 'live', ...identity };
  record.stages.accountCreated = true;
}

export function prepareDeviceAcl(
  record: NvxCleanupRecord,
  identity: NvxCleanupDeviceAclIdentity,
): void {
  if (!record.resources.deviceAcls.some(({ path: aclPath }) => aclPath === identity.path)) {
    record.resources.deviceAcls.push(identity);
  }
  record.stages.deviceAclsGranted = record.resources.deviceAcls.length > 0;
}

export function releaseDeviceAcl(
  record: NvxCleanupRecord,
  identity: NvxCleanupDeviceAclIdentity,
): void {
  const index = record.resources.deviceAcls.findIndex(({ path: aclPath }) =>
    aclPath === identity.path);
  if (index >= 0) record.resources.deviceAcls.splice(index, 1);
  record.stages.deviceAclsGranted = record.resources.deviceAcls.length > 0;
}

export async function captureNetworkPlan(
  record: NvxCleanupRecord,
  layout: NvxRunLayout,
  plan: MicrovmNetworkPlan,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat'>,
): Promise<void> {
  if (plan.runId !== record.runId || plan.namespaceName !== layout.networkNamespace) {
    throw new Error('NVX cleanup network plan is not bound to the run');
  }
  record.network = {
    resourceToken: plan.resourceToken,
    namespaceName: plan.namespaceName,
    netnsPath: plan.netnsPath,
    hostVethName: plan.hostVethName,
    namespaceVethName: plan.namespaceVethName,
    tapName: plan.tapName,
    infrastructureBridge: plan.infrastructureBridge,
    hostForwardRuleComment: plan.hostForwardRuleComment,
  };
  if (plan.reservationPath) {
    record.resources.networkReservation = await captureFile(plan.reservationPath, dependencies);
  }
}

export async function captureNetworkResource(
  record: NvxCleanupRecord,
  resource: 'netns' | 'hostVeth' | 'namespaceVeth' | 'tap',
  ipPath: string,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat' | 'run'>,
): Promise<void> {
  const network = requireNetwork(record);
  if (resource === 'netns') {
    record.resources.networkNamespace = await captureFile(network.netnsPath, dependencies);
    record.stages.networkCreated = true;
  } else {
    const identity = await captureInterface(
      network[resource === 'hostVeth'
        ? 'hostVethName'
        : resource === 'namespaceVeth'
          ? 'namespaceVethName'
          : 'tapName'],
      resource === 'hostVeth' ? undefined : network.namespaceName,
      ipPath,
      dependencies,
    );
    record.resources[resource] = identity;
  }
}

export async function captureRunDirectory(
  record: NvxCleanupRecord,
  layout: NvxRunLayout,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat'>,
): Promise<void> {
  record.resources.runDirectory = await captureFile(layout.runDirectory, dependencies);
  record.stages.runDirectoryCreated = true;
}

export async function captureCgroup(
  record: NvxCleanupRecord,
  layout: NvxRunLayout,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat'>,
): Promise<void> {
  record.resources.cgroup = await captureFile(layout.cgroupPath, dependencies);
  record.stages.cgroupCreated = true;
}

export async function captureProcess(
  record: NvxCleanupRecord,
  kind: 'launcher' | 'openvmm',
  pid: number,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'readFile' | 'readlink' | 'stat'>,
): Promise<NvxCleanupProcessIdentity> {
  const identity = await captureProcessIdentity(pid, dependencies);
  record.resources[kind] = identity;
  if (kind === 'launcher') record.stages.processStarted = true;
  return identity;
}

export function captureMountNamespace(record: NvxCleanupRecord, inode: string): void {
  if (!/^\d+$/.test(inode)) throw new Error('NVX mount namespace inode is invalid');
  record.resources.mountNamespaceInode = inode;
}

export async function captureFile(
  filePath: string,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'lstat'>,
): Promise<NvxCleanupFileIdentity> {
  const stat = await dependencies.lstat(filePath, { bigint: true });
  return { path: filePath, device: stat.dev.toString(), inode: stat.ino.toString() };
}

async function captureInterface(
  name: string,
  namespace: string | undefined,
  ipPath: string,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'run'>,
): Promise<NvxCleanupInterfaceIdentity> {
  const value = await tryCaptureInterface(name, namespace, ipPath, dependencies);
  if (!value) throw new Error(`Could not capture NVX interface ${name}`);
  return value;
}

export async function tryCaptureInterface(
  name: string,
  namespace: string | undefined,
  ipPath: string,
  dependencies: Pick<NvxCleanupRegistryDependencies, 'run'>,
): Promise<NvxCleanupInterfaceIdentity | undefined> {
  const args = namespace
    ? ['netns', 'exec', namespace, ipPath, '-json', 'link', 'show', 'dev', name]
    : ['-json', 'link', 'show', 'dev', name];
  const result = await dependencies.run(ipPath, args);
  if (result.exitCode !== 0) {
    if (result.exitCode === 1 && result.stderr.trim() === `Device "${name}" does not exist.`) {
      return undefined;
    }
    throw new Error(
      `Could not inspect NVX interface ${name}: ${result.stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Array<{ ifname?: string; ifindex?: number }>;
  if (parsed.length !== 1 || parsed[0].ifname !== name || !Number.isSafeInteger(parsed[0].ifindex)) {
    throw new Error(`Invalid NVX interface identity for ${name}`);
  }
  return { name, ...(namespace ? { namespace } : {}), ifindex: parsed[0].ifindex as number };
}
