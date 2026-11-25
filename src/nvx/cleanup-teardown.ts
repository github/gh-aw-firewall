import * as path from 'path';
import {
  exists,
  validatePendingAccountGroup,
  validatePendingAccountPasswd,
} from './cleanup-account-validation';
import { captureFile, tryCaptureInterface } from './cleanup-capture';
import { bridgeForwardRule, sameInterface } from './cleanup-network-state';
import { captureProcessIdentity, sameProcess } from './cleanup-process-identity';
import type {
  NvxCleanupFileIdentity,
  NvxCleanupProcessIdentity,
  NvxCleanupRecord,
} from './cleanup-record';
import type { NvxCleanupRegistryDependencies, NvxCleanupToolPaths } from './cleanup-registry';

export async function stopRecordedProcesses(
  record: NvxCleanupRecord,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  for (const identity of [record.resources.openvmm, record.resources.launcher]) {
    if (!identity || !(await processMatches(identity, dependencies))) continue;
    dependencies.kill(identity.pid, 'SIGTERM');
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = await Promise.all(
      [record.resources.openvmm, record.resources.launcher]
        .filter((value): value is NvxCleanupProcessIdentity => value !== undefined)
        .map((identity) => processMatches(identity, dependencies)),
    );
    if (live.every((value) => !value)) return;
    await dependencies.sleep(50);
  }
  for (const identity of [record.resources.openvmm, record.resources.launcher]) {
    if (identity && await processMatches(identity, dependencies)) dependencies.kill(identity.pid, 'SIGKILL');
  }
  for (const identity of [record.resources.openvmm, record.resources.launcher]) {
    if (identity && await processMatches(identity, dependencies)) {
      throw new Error(`NVX process ${identity.pid} did not terminate`);
    }
  }
}

export async function removeNetwork(
  record: NvxCleanupRecord,
  ipPath: string,
  iptablesPath: string,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  if (!record.network) return;
  const network = record.network;
  const reservation = record.resources.networkReservation;
  const hostVeth = await tryCaptureInterface(network.hostVethName, undefined, ipPath, dependencies);
  const netnsExists = await exists(network.netnsPath, dependencies.lstat);
  if (hostVeth || netnsExists) {
    if (!reservation) {
      throw new Error('NVX network exists without a committed reservation identity');
    }
    if (path.basename(reservation.path) !== `${network.resourceToken}.json`) {
      throw new Error('NVX network reservation is not bound to the resource token');
    }
    await assertFileIdentity(reservation, dependencies);
  }
  if (hostVeth) {
    if (record.resources.hostVeth && !sameInterface(hostVeth, record.resources.hostVeth)) {
      throw new Error('NVX host veth identity changed');
    }
  }
  if (netnsExists) {
    if (record.resources.networkNamespace) {
      await assertFileIdentity(record.resources.networkNamespace, dependencies);
    }
    for (const [name, expected] of [
      [network.namespaceVethName, record.resources.namespaceVeth],
      [network.tapName, record.resources.tap],
    ] as const) {
      const current = await tryCaptureInterface(name, network.namespaceName, ipPath, dependencies);
      if (current && expected && !sameInterface(current, expected)) {
        throw new Error(`NVX interface identity changed: ${name}`);
      }
    }
  }
  if (hostVeth) {
    await runChecked(ipPath, ['link', 'delete', network.hostVethName], dependencies);
  }
  if (netnsExists) {
    await runChecked(ipPath, ['netns', 'delete', network.namespaceName], dependencies);
  }
  const check = bridgeForwardRule(
    '-C', network.infrastructureBridge, network.hostForwardRuleComment,
  );
  const checked = await dependencies.run(iptablesPath, check);
  if (checked.exitCode === 0) {
    await runChecked(iptablesPath, bridgeForwardRule(
      '-D', network.infrastructureBridge, network.hostForwardRuleComment,
    ), dependencies);
  } else if (checked.exitCode !== 1) {
    throw new Error(`Could not revalidate NVX bridge rule: ${checked.stderr || checked.stdout}`);
  }
}

export async function removeIdentity(
  record: NvxCleanupRecord,
  tools: NvxCleanupToolPaths,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  const identity = record.vmmIdentity;
  if (!identity) return;
  const passwd = await dependencies.run(tools.getent, ['passwd', identity.name]);
  const group = await dependencies.run(tools.getent, ['group', identity.name]);
  const expected = identity.state === 'live'
    ? { uid: identity.uid!, gid: identity.gid! }
    : undefined;
  let observed: { uid: number; gid: number } | undefined;
  if (passwd.exitCode === 0) {
    observed = validatePendingAccountPasswd(passwd.stdout, identity.name, record.runId);
    if (
      expected &&
      (observed.uid !== expected.uid || observed.gid !== expected.gid)
    ) {
      throw new Error(`Refusing to remove reused NVX account ${identity.name}`);
    }
    const groups = await dependencies.run(tools.id, ['-G', identity.name]);
    if (
      groups.exitCode !== 0 ||
      groups.stdout.trim() !== String(observed.gid)
    ) {
      throw new Error(`NVX account ${identity.name} has unexpected supplementary groups`);
    }
  } else if (passwd.stderr.trim()) {
    throw new Error(`Could not validate NVX account ${identity.name}: ${passwd.stderr}`);
  }
  if (group.exitCode === 0) {
    validatePendingAccountGroup(
      group.stdout,
      identity.name,
      expected?.gid ?? observed?.gid,
    );
  } else if (group.stderr.trim()) {
    throw new Error(`Could not validate NVX group ${identity.name}: ${group.stderr}`);
  }
  if (
    passwd.exitCode === 0 &&
    identity.state === 'live' &&
    identity.uid !== undefined &&
    identity.gid !== undefined
  ) {
    await dependencies.withDeviceAclLock(async () => {
      for (const acl of record.resources.deviceAcls) {
        const current = await captureFile(acl.path, dependencies);
        if (current.device !== acl.device || current.inode !== acl.inode || acl.uid !== identity.uid) {
          throw new Error(`NVX device identity changed for ${acl.path}`);
        }
        await runChecked(tools.setfacl, ['--remove', `user:${identity.uid}`, acl.path], dependencies);
      }
    });
  }
  if (passwd.exitCode === 0) {
    await runChecked(tools.userdel, [identity.name], dependencies);
  }
  if (group.exitCode === 0) {
    const remainingGroup = await dependencies.run(tools.getent, [
      'group', identity.name,
    ]);
    if (remainingGroup.exitCode === 0) {
      validatePendingAccountGroup(
        remainingGroup.stdout,
        identity.name,
        expected?.gid ?? observed?.gid,
      );
      await runChecked(tools.groupdel, [identity.name], dependencies);
    } else if (remainingGroup.stderr.trim()) {
      throw new Error(
        `Could not revalidate NVX group ${identity.name}: ${remainingGroup.stderr}`,
      );
    }
  }
}

export async function removeExactDirectory(
  expected: NvxCleanupFileIdentity | undefined,
  recursive: boolean,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  if (!expected || !(await exists(expected.path, dependencies.lstat))) return;
  await assertFileIdentity(expected, dependencies);
  if (recursive) {
    await dependencies.rm(expected.path, { recursive: true, force: false });
  } else {
    await dependencies.rmdir(expected.path);
  }
}

export async function removeExactFile(
  expected: NvxCleanupFileIdentity | undefined,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  if (!expected || !(await exists(expected.path, dependencies.lstat))) return;
  await assertFileIdentity(expected, dependencies);
  await dependencies.rm(expected.path, { force: false });
}

async function assertFileIdentity(
  expected: NvxCleanupFileIdentity | undefined,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  if (!expected) throw new Error('NVX resource exists without a committed identity');
  const current = await captureFile(expected.path, dependencies);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error(`NVX resource identity changed: ${expected.path}`);
  }
}

export async function processMatches(
  expected: NvxCleanupProcessIdentity,
  dependencies: NvxCleanupRegistryDependencies,
): Promise<boolean> {
  try {
    return sameProcess(await captureProcessIdentity(expected.pid, dependencies), expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runChecked(
  command: string,
  args: readonly string[],
  dependencies: NvxCleanupRegistryDependencies,
): Promise<void> {
  const result = await dependencies.run(command, args);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}
