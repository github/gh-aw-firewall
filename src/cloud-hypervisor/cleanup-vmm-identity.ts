import type { CleanupRecord } from './cleanup-identity';
import * as path from 'path';
import {
  resolveTemporaryVmmAclUids,
  withCloudHypervisorDeviceAclLock,
  type CloudHypervisorVmmIdentityDependencies,
  type CloudHypervisorVmmIdentityToolPaths,
} from './vmm-identity';
import { runChecked, type ResolvedCleanupDependencies } from './cleanup-dependencies';
import {
  composeDeviceAcl,
  describeDeviceAclShape,
  deviceAclArgument,
  parseDeviceAcl,
  sameDeviceAcl,
  type CloudHypervisorDevicePath,
} from './device-acl';

type RecordedVmmIdentity = NonNullable<CleanupRecord['vmmIdentity']>;

export async function deleteVmmIdentity(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  tools: CloudHypervisorVmmIdentityToolPaths | undefined,
  persist?: () => Promise<void>,
): Promise<void> {
  const identity = record.vmmIdentity;
  if (!identity) return;
  if (!tools) throw new Error('VMM cleanup tools are unavailable for a recorded account');
  const accessedAclPaths = identity.accessedAclPaths ?? identity.aclPaths;
  if (accessedAclPaths.length > 0 && identity.state !== 'live') {
    throw new Error(`VMM ACL intent lacks a committed numeric identity: ${identity.name}`);
  }
  if (identity.state === 'live' && accessedAclPaths.length > 0) {
    await withVmmAclLock(dependencies, tools, async () => {
      await prepareMissingVmmAclsLocked(
        dependencies,
        identity,
        accessedAclPaths,
        tools,
        persist,
      );
      const restoredTargets = await restoreVmmAclsLocked(dependencies, identity, tools);
      const expectedGid = await deleteVmmAccount(dependencies, record, identity, tools);
      await deleteVmmGroup(dependencies, identity, tools, expectedGid);
      await restoreVmmAclsLocked(dependencies, identity, tools, restoredTargets);
    });
    return;
  }

  const expectedGid = await deleteVmmAccount(dependencies, record, identity, tools);
  await deleteVmmGroup(dependencies, identity, tools, expectedGid);
}

async function prepareMissingVmmAclsLocked(
  dependencies: ResolvedCleanupDependencies,
  identity: RecordedVmmIdentity,
  accessedAclPaths: readonly CloudHypervisorDevicePath[],
  tools: CloudHypervisorVmmIdentityToolPaths,
  persist?: () => Promise<void>,
): Promise<void> {
  for (const aclPath of accessedAclPaths) {
    if (identity.aclPaths.includes(aclPath)) continue;
    const currentResult = await dependencies.run(tools.getfacl, [
      '--absolute-names', '--numeric', aclPath,
    ]);
    if (currentResult.exitCode !== 0) {
      throw new Error(
        `VMM ACL baseline capture failed for ${aclPath}: ${currentResult.stderr.trim()}`,
      );
    }
    const baseline = parseDeviceAcl(currentResult.stdout);
    const temporaryUids = await resolveTemporaryVmmAclUids(
      baseline,
      tools,
      dependencies.run,
    );
    identity.aclPaths.push(aclPath);
    identity.aclBaselines ??= {};
    identity.aclBaselines[aclPath] = baseline;
    identity.aclTemporaryUids ??= {};
    identity.aclTemporaryUids[aclPath] = temporaryUids;
    identity.accessedAclBaselines ??= {};
    identity.accessedAclTemporaryUids ??= {};
    identity.accessedAclBaselines[aclPath] ??= baseline;
    identity.accessedAclTemporaryUids[aclPath] ??= temporaryUids;
    try {
      if (persist) await persist();
    } catch (error) {
      identity.aclPaths.pop();
      delete identity.aclBaselines[aclPath];
      delete identity.aclTemporaryUids[aclPath];
      if (identity.accessedAclBaselines?.[aclPath] === baseline) {
        delete identity.accessedAclBaselines[aclPath];
        delete identity.accessedAclTemporaryUids?.[aclPath];
      }
      throw error;
    }
    if (baseline.some((entry) => entry.startsWith(`user:${identity.uid}:`))) {
      throw new Error(`VMM ACL still grants access to ${identity.uid} on ${aclPath}`);
    }
  }
}

async function withVmmAclLock(
  dependencies: ResolvedCleanupDependencies,
  tools: CloudHypervisorVmmIdentityToolPaths,
  operation: () => Promise<void>,
): Promise<void> {
  const lockDependencies: Partial<CloudHypervisorVmmIdentityDependencies> = {
    mkdir: dependencies.mkdir,
    writeFile: dependencies.writeFile,
    readFile: dependencies.readFile,
    rm: dependencies.rm,
    rmdir: dependencies.rmdir,
    lstat: dependencies.lstat,
    sleep: dependencies.sleep,
    pid: dependencies.processId,
  };
  await withCloudHypervisorDeviceAclLock(
    tools,
    operation,
    lockDependencies,
    path.join(path.dirname(dependencies.rootDirectory), '.device-acl-lock'),
  );
}

async function restoreVmmAclsLocked(
  dependencies: ResolvedCleanupDependencies,
  identity: RecordedVmmIdentity,
  tools: CloudHypervisorVmmIdentityToolPaths,
  retainedTargets?: ReadonlyMap<CloudHypervisorDevicePath, readonly string[]>,
): Promise<Map<CloudHypervisorDevicePath, string[]>> {
  const restoredTargets = new Map<CloudHypervisorDevicePath, string[]>();
  for (const aclPath of [...identity.aclPaths].reverse()) {
    const baseline = identity.aclBaselines?.[aclPath as CloudHypervisorDevicePath];
    if (baseline) {
      const retainedTarget = retainedTargets?.get(aclPath as CloudHypervisorDevicePath);
      let restoredTarget: string[];
      if (retainedTarget) {
        restoredTarget = [...retainedTarget];
      } else {
        const before = await dependencies.run(tools.getfacl, [
          '--absolute-names', '--numeric', aclPath,
        ]);
        if (before.exitCode !== 0) {
          throw new Error(
            `VMM ACL restoration validation failed for ${aclPath}: ${before.stderr.trim()}`,
          );
        }
        const current = parseDeviceAcl(before.stdout);
        const liveTemporaryUids = await resolveTemporaryVmmAclUids(
          current,
          tools,
          dependencies.run,
        );
        restoredTarget = composeDeviceAcl(
          baseline,
          current,
          identity.uid!,
          identity.aclTemporaryUids?.[aclPath as CloudHypervisorDevicePath] ?? [],
          liveTemporaryUids,
          identity.accessedAclBaselines?.[aclPath as CloudHypervisorDevicePath] ?? baseline,
          identity.accessedAclTemporaryUids?.[
            aclPath as CloudHypervisorDevicePath
          ] ?? identity.aclTemporaryUids?.[
            aclPath as CloudHypervisorDevicePath
          ] ?? [],
        );
      }
      restoredTargets.set(aclPath as CloudHypervisorDevicePath, restoredTarget);
      await runChecked(dependencies.run, tools.setfacl, [
        `--set=${deviceAclArgument(restoredTarget)}`, aclPath,
      ]);
      const restored = await dependencies.run(tools.getfacl, [
        '--absolute-names', '--numeric', aclPath,
      ]);
      if (restored.exitCode !== 0) {
        throw new Error(
          `VMM ACL restoration validation failed for ${aclPath}: ${restored.stderr.trim()}`,
        );
      }
      const restoredAcl = parseDeviceAcl(restored.stdout);
      if (!sameDeviceAcl(restoredAcl, restoredTarget)) {
        throw new Error(
          `VMM ACL restoration validation failed for ${aclPath}: ` +
          `before=${describeDeviceAclShape(restoredTarget)} ` +
          `after=${describeDeviceAclShape(restoredAcl)}`,
        );
      }
      continue;
    }
    let acl = await dependencies.run(tools.getfacl, [
      '--absolute-names', '--numeric', aclPath,
    ]);
    if (acl.exitCode !== 0) {
      throw new Error(`VMM ACL revalidation failed for ${aclPath}: ${acl.stderr.trim()}`);
    }
    if (acl.stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${identity.uid}:`))) {
      await runChecked(dependencies.run, tools.setfacl, [
        '--remove', `user:${identity.uid}`, aclPath,
      ]);
      acl = await dependencies.run(tools.getfacl, ['--absolute-names', '--numeric', aclPath]);
      if (
        acl.exitCode !== 0 ||
        acl.stdout.split(/\r?\n/).some((line) => line.startsWith(`user:${identity.uid}:`))
      ) throw new Error(`VMM ACL removal validation failed for ${aclPath}`);
    }
  }
  return restoredTargets;
}

/**
 * Revalidates and deletes the recorded VMM account, returning the group id that
 * the matching group entry must still carry.
 */
async function deleteVmmAccount(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  identity: RecordedVmmIdentity,
  tools: CloudHypervisorVmmIdentityToolPaths,
): Promise<number | undefined> {
  const passwd = await dependencies.run(tools.getent, ['passwd', identity.name]);
  if (passwd.exitCode === 2) return identity.state === 'live' ? identity.gid : undefined;
  if (passwd.exitCode !== 0) {
    throw new Error(`Could not revalidate VMM account ${identity.name}: ${passwd.stderr.trim()}`);
  }
  const fields = passwd.stdout.trim().split(':');
  if (
    fields.length !== 7 ||
    fields[0] !== identity.name ||
    fields[4] !== `AWF Cloud Hypervisor ${record.runId}` ||
    fields[5] !== '/nonexistent' ||
    fields[6] !== '/usr/sbin/nologin' ||
    (identity.state === 'live' &&
      (fields[2] !== String(identity.uid) || fields[3] !== String(identity.gid)))
  ) throw new Error(`VMM account identity changed: ${identity.name}`);
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0
  ) {
    throw new Error(`VMM account uid is invalid: ${identity.name}`);
  }
  if (identity.state === 'live') {
    await assertRuntimeIdentityUnchanged(dependencies, identity, tools);
  }
  await runChecked(dependencies.run, tools.userdel, [identity.name]);
  const removed = await dependencies.run(tools.id, ['-u', identity.name]);
  if (removed.exitCode !== 1) {
    throw new Error(`VMM account deletion could not be verified: ${identity.name}`);
  }
  return gid;
}

async function assertRuntimeIdentityUnchanged(
  dependencies: ResolvedCleanupDependencies,
  identity: RecordedVmmIdentity,
  tools: CloudHypervisorVmmIdentityToolPaths,
): Promise<void> {
  const [currentUid, currentGid, currentGroups] = await Promise.all([
    dependencies.run(tools.id, ['-u', identity.name]),
    dependencies.run(tools.id, ['-g', identity.name]),
    dependencies.run(tools.id, ['-G', identity.name]),
  ]);
  if (
    currentUid.exitCode !== 0 ||
    currentUid.stdout.trim() !== String(identity.uid) ||
    currentGid.exitCode !== 0 ||
    currentGid.stdout.trim() !== String(identity.gid) ||
    currentGroups.exitCode !== 0 ||
    currentGroups.stdout.trim() !== String(identity.gid)
  ) throw new Error(`VMM account runtime identity changed: ${identity.name}`);
}

async function deleteVmmGroup(
  dependencies: ResolvedCleanupDependencies,
  identity: RecordedVmmIdentity,
  tools: CloudHypervisorVmmIdentityToolPaths,
  expectedGid: number | undefined,
): Promise<void> {
  const group = await dependencies.run(tools.getent, ['group', identity.name]);
  if (group.exitCode === 2) return;
  if (group.exitCode !== 0) {
    throw new Error(`Could not revalidate VMM group ${identity.name}: ${group.stderr.trim()}`);
  }
  const fields = group.stdout.trim().split(':');
  if (
    expectedGid === undefined ||
    fields.length !== 4 ||
    fields[0] !== identity.name ||
    fields[2] !== String(expectedGid) ||
    fields[3] !== ''
  ) {
    throw new Error(`VMM group identity changed: ${identity.name}`);
  }
  await runChecked(dependencies.run, tools.groupdel, [identity.name]);
  const removed = await dependencies.run(tools.getent, ['group', identity.name]);
  if (removed.exitCode !== 2) {
    throw new Error(`VMM group deletion could not be verified: ${identity.name}`);
  }
}
