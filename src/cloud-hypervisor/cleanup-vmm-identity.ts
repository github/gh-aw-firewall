import type { CleanupRecord } from './cleanup-identity';
import type { CloudHypervisorVmmIdentityToolPaths } from './vmm-identity';
import { runChecked, type ResolvedCleanupDependencies } from './cleanup-dependencies';

type RecordedVmmIdentity = NonNullable<CleanupRecord['vmmIdentity']>;

export async function deleteVmmIdentity(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  tools: CloudHypervisorVmmIdentityToolPaths | undefined,
): Promise<void> {
  const identity = record.vmmIdentity;
  if (!identity) return;
  if (!tools) throw new Error('VMM cleanup tools are unavailable for a recorded account');
  if (identity.aclPaths.length > 0 && identity.state !== 'live') {
    throw new Error(`VMM ACL intent lacks a committed numeric identity: ${identity.name}`);
  }
  if (identity.state === 'live') {
    await releaseVmmAcls(dependencies, identity, tools);
  }
  const expectedGid = await deleteVmmAccount(dependencies, record, identity, tools);
  await deleteVmmGroup(dependencies, identity, tools, expectedGid);
}

async function releaseVmmAcls(
  dependencies: ResolvedCleanupDependencies,
  identity: RecordedVmmIdentity,
  tools: CloudHypervisorVmmIdentityToolPaths,
): Promise<void> {
  for (const aclPath of [...identity.aclPaths].reverse()) {
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
