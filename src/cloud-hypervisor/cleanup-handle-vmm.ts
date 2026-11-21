import type { CloudHypervisorVmmIdentity } from './vmm-identity';
import type { CloudHypervisorCleanupHandle } from './cleanup-registry';
import type { CleanupHandleFactoryOptions } from './cleanup-handle';
import { parseDeviceAcl, type CloudHypervisorDevicePath } from './device-acl';

export function createVmmCleanupHandle(
  options: CleanupHandleFactoryOptions,
  update: () => Promise<void>,
): Pick<CloudHypervisorCleanupHandle,
  'prepareVmmAccount' | 'captureVmmIdentity' | 'prepareVmmAcl' | 'releaseVmmAcl'
> {
  const { record } = options;
  return {
    prepareVmmAccount: async (name: string) => {
      if (!/^awfvmm-[a-f0-9]{20}$/.test(name) || record.vmmIdentity) {
        throw new Error(`Unsafe or duplicate VMM cleanup account: ${name}`);
      }
      record.vmmIdentity = { state: 'pending', name, aclPaths: [], accessedAclPaths: [] };
      await update();
    },
    captureVmmIdentity: async (identity: CloudHypervisorVmmIdentity) => {
      const pending = record.vmmIdentity;
      if (
        !pending ||
        pending.name !== identity.name ||
        !Number.isSafeInteger(identity.uid) ||
        identity.uid <= 0 ||
        !Number.isSafeInteger(identity.gid) ||
        identity.gid <= 0
      ) throw new Error('VMM cleanup identity does not match its pending account');
      record.vmmIdentity = { ...pending, state: 'live', uid: identity.uid, gid: identity.gid };
      await update();
    },
    prepareVmmAcl: async (
      aclPath: CloudHypervisorDevicePath,
      baseline: readonly string[],
      temporaryUids: readonly number[] = [],
    ) => {
      if (!record.vmmIdentity || record.vmmIdentity.state !== 'live') {
        throw new Error('VMM cleanup identity is not committed before ACL grant');
      }
      if (aclPath !== '/dev/kvm' && aclPath !== '/dev/net/tun') {
        throw new Error(`Unsafe VMM ACL cleanup path: ${aclPath}`);
      }
      const validatedBaseline = parseDeviceAcl(baseline.join('\n'));
      record.vmmIdentity.accessedAclPaths ??= [];
      if (!record.vmmIdentity.accessedAclPaths.includes(aclPath)) {
        record.vmmIdentity.accessedAclPaths.push(aclPath);
      }
      record.vmmIdentity.accessedAclBaselines ??= {};
      record.vmmIdentity.accessedAclTemporaryUids ??= {};
      record.vmmIdentity.accessedAclBaselines[aclPath] ??= validatedBaseline;
      record.vmmIdentity.accessedAclTemporaryUids[aclPath] ??= [...temporaryUids];
      if (!record.vmmIdentity.aclPaths.includes(aclPath)) {
        record.vmmIdentity.aclPaths.push(aclPath);
        record.vmmIdentity.aclBaselines ??= {};
        record.vmmIdentity.aclBaselines[aclPath] = validatedBaseline;
        record.vmmIdentity.aclTemporaryUids ??= {};
        record.vmmIdentity.aclTemporaryUids[aclPath] = [...temporaryUids];
        await update();
      } else if (
        JSON.stringify(record.vmmIdentity.aclBaselines?.[aclPath]) !==
        JSON.stringify(validatedBaseline) ||
        JSON.stringify(record.vmmIdentity.aclTemporaryUids?.[aclPath] ?? []) !==
        JSON.stringify(temporaryUids)
      ) {
        throw new Error(`VMM ACL cleanup baseline changed for ${aclPath}`);
      }
    },
    releaseVmmAcl: async (aclPath: CloudHypervisorDevicePath) => {
      if (!record.vmmIdentity || record.vmmIdentity.state !== 'live') {
        throw new Error('VMM cleanup identity is not committed before ACL release');
      }
      const index = record.vmmIdentity.aclPaths.indexOf(aclPath);
      if (index < 0) throw new Error(`VMM ACL cleanup intent is missing for ${aclPath}`);
      record.vmmIdentity.aclPaths.splice(index, 1);
      if (record.vmmIdentity.aclBaselines) {
        delete record.vmmIdentity.aclBaselines[aclPath];
      }
      if (record.vmmIdentity.aclTemporaryUids) {
        delete record.vmmIdentity.aclTemporaryUids[aclPath];
      }
      await update();
    },
  };
}
