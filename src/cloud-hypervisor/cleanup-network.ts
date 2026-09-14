import type { CleanupRecord, FileIdentity, InterfaceIdentity } from './cleanup-identity';
import {
  bridgeForwardRule,
  captureFileIdentity,
  interfaceExists,
  tryCaptureInterfaceIdentity,
} from './cleanup-process';
import { sameFileIdentity } from './cleanup-identity';
import {
  pathExists,
  runChecked,
  type ResolvedCleanupDependencies,
} from './cleanup-dependencies';

async function validateFileIfPresent(
  dependencies: ResolvedCleanupDependencies,
  filePath: string,
  expected: FileIdentity | undefined,
  label: string,
): Promise<void> {
  if (!(await pathExists(filePath, dependencies.lstat))) return;
  if (!expected) throw new Error(`${label} exists but its immutable identity was never committed`);
  const current = await captureFileIdentity(dependencies.lstat, filePath);
  if (!sameFileIdentity(current, expected)) throw new Error(`${label} identity changed`);
}

async function validateInterfaceIfPresent(
  dependencies: ResolvedCleanupDependencies,
  ipPath: string,
  name: string,
  expected: InterfaceIdentity | undefined,
  namespace: string | undefined,
): Promise<void> {
  const current = await tryCaptureInterfaceIdentity(dependencies.run, ipPath, name, namespace);
  if (!current) return;
  if (!expected) throw new Error(`interface "${name}" exists but its identity was never committed`);
  if (current.ifindex !== expected.ifindex || current.namespace !== expected.namespace) {
    throw new Error(`interface "${name}" identity changed`);
  }
}

export async function validateRecordResources(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  ipPath: string,
): Promise<void> {
  const network = record.network;
  const netnsExists = network ? await pathExists(network.netnsPath, dependencies.lstat) : false;
  if (network) {
    await validateFileIfPresent(dependencies, network.netnsPath, record.identities.netns, 'netns');
  }
  await validateFileIfPresent(
    dependencies, record.paths.runDirectory, record.identities.runDirectory, 'run directory',
  );
  await validateFileIfPresent(
    dependencies, record.paths.cgroupPath, record.identities.cgroup, 'cgroup',
  );
  await validateFileIfPresent(
    dependencies,
    record.paths.virtiofsdShareDirectory,
    record.identities.virtiofsdShareDirectory,
    'virtiofsd share directory',
  );
  if (record.paths.artifactSnapshotDirectory) {
    await validateFileIfPresent(
      dependencies,
      record.paths.artifactSnapshotDirectory,
      record.identities.artifactSnapshotDirectory,
      'artifact snapshot directory',
    );
  }
  if (network) {
    await validateInterfaceIfPresent(
      dependencies, ipPath, network.hostVethName, record.identities.hostVeth, undefined,
    );
  }
  if (network && netnsExists) {
    await validateInterfaceIfPresent(
      dependencies,
      ipPath,
      network.namespaceVethName,
      record.identities.namespaceVeth,
      network.namespaceName,
    );
    await validateInterfaceIfPresent(
      dependencies, ipPath, network.tapName, record.identities.tap, network.namespaceName,
    );
  }
}

export async function deleteNetwork(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  ipPath: string,
): Promise<void> {
  const network = requireNetwork(record);
  if (await interfaceExists(dependencies.run, ipPath, network.hostVethName)) {
    await validateInterfaceIfPresent(
      dependencies,
      ipPath,
      network.hostVethName,
      record.identities.hostVeth,
      undefined,
    );
    await runChecked(dependencies.run, ipPath, ['link', 'delete', network.hostVethName]);
  }
  if (await pathExists(network.netnsPath, dependencies.lstat)) {
    await validateFileIfPresent(
      dependencies,
      network.netnsPath,
      record.identities.netns,
      'netns',
    );
    await runChecked(dependencies.run, ipPath, ['netns', 'delete', network.namespaceName]);
  }
  const rule = bridgeForwardRule(
    '-C',
    network.infrastructureBridge,
    network.hostForwardRuleComment,
  );
  const checked = await dependencies.run('iptables', rule);
  if (checked.exitCode === 0) {
    await runChecked(dependencies.run, 'iptables', bridgeForwardRule(
      '-D',
      network.infrastructureBridge,
      network.hostForwardRuleComment,
    ));
  } else if (checked.exitCode !== 1) {
    throw new Error(
      `Could not revalidate per-run bridge rule: ${checked.stderr.trim() || checked.stdout.trim()}`,
    );
  }
}

function requireNetwork(record: CleanupRecord): NonNullable<CleanupRecord['network']> {
  if (!record.network) throw new Error('Cleanup network plan is not committed');
  return record.network;
}
