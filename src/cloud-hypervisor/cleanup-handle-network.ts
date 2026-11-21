import * as path from 'path';
import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorEmptyNetworkNamespacePlan } from './network-namespace';
import type { CloudHypervisorCleanupHandle, CloudHypervisorNetworkResource } from './cleanup-registry';
import type { CleanupHandleFactoryOptions } from './cleanup-handle';
import { assertSafeRecordPaths, type CleanupRecord } from './cleanup-identity';

export function createNetworkCleanupHandle(
  options: CleanupHandleFactoryOptions,
  update: () => Promise<void>,
): Pick<CloudHypervisorCleanupHandle,
  'captureNetworkPlan' | 'captureEmptyNetworkNamespace' | 'captureNetworkResource'
> {
  const { record, ipPath } = options;
  return {
    captureNetworkPlan: async (plan: MicrovmNetworkPlan) => {
      assertSafeNetworkRecordPaths(record, plan);
      if (record.network) throw new Error('Cleanup network plan is already committed');
      record.network = serializeNetworkPlan(plan);
      await update();
    },
    captureEmptyNetworkNamespace: async (plan: CloudHypervisorEmptyNetworkNamespacePlan) => {
      assertSafeNetworkRecordPaths(record);
      if (record.network) throw new Error('Cleanup network namespace is already committed');
      record.network = {
        mode: 'none',
        namespaceName: plan.namespaceName,
        netnsPath: plan.netnsPath,
      };
      await update();
    },
    captureNetworkResource: async (resource: CloudHypervisorNetworkResource) => {
      const network = requireNetwork(record);
      if (network.mode === 'none') {
        if (resource !== 'netns') {
          throw new Error(`Closed network namespace cannot capture ${resource}`);
        }
        record.identities.netns = await options.captureFileIdentity(network.netnsPath);
        await update();
        return;
      }
      switch (resource) {
        case 'netns':
          record.identities.netns = await options.captureFileIdentity(network.netnsPath);
          break;
        case 'hostVeth':
          record.identities.hostVeth = await options.captureInterfaceIdentity(
            ipPath, network.hostVethName,
          );
          break;
        case 'namespaceVeth':
          record.identities.namespaceVeth = await options.captureInterfaceIdentity(
            ipPath, network.namespaceVethName, network.namespaceName,
          );
          break;
        case 'tap':
          record.identities.tap = await options.captureInterfaceIdentity(
            ipPath, network.tapName, network.namespaceName,
          );
          break;
      }
      await update();
    },
  };
}

function assertSafeNetworkRecordPaths(record: CleanupRecord, plan?: MicrovmNetworkPlan): void {
  assertSafeRecordPaths({
    ...record.paths,
    runId: record.runId,
    runBaseDir: path.dirname(path.dirname(record.paths.runDirectory)),
  }, plan);
}

function serializeNetworkPlan(plan: MicrovmNetworkPlan): CleanupRecord['network'] {
  return {
    mode: plan.mode ?? 'primary',
    namespaceName: plan.namespaceName,
    netnsPath: plan.netnsPath,
    hostVethName: plan.hostVethName,
    namespaceVethName: plan.namespaceVethName,
    tapName: plan.tapName,
    infrastructureBridge: plan.infrastructureBridge,
    hostForwardRuleComment: plan.hostForwardRuleComment,
  };
}

function requireNetwork(record: CleanupRecord): NonNullable<CleanupRecord['network']> {
  if (!record.network) throw new Error('Cleanup network plan is not committed');
  return record.network;
}
