import type { MicrovmNetworkPlan, MicrovmNetworkPlanOptions } from '../microvm/network';
import { resolveCloudHypervisorEnclaveNetwork } from './enclave-network';
import {
  formatError,
  type CloudHypervisorManagerNetworkConfig,
} from './manager-types';
import { createCloudHypervisorEmptyNetworkNamespacePlan } from './network-namespace';
import type { CloudHypervisorPreflightResult } from './preflight';
import type {
  CloudHypervisorStartCheck,
  CloudHypervisorStartContext,
  CloudHypervisorStartResources,
} from './manager-start';

type StartNetworkConfig = CloudHypervisorManagerNetworkConfig &
  Pick<MicrovmNetworkPlanOptions, 'enclaveAgent'>;

export interface CloudHypervisorStartNetwork {
  networkConfig: StartNetworkConfig | undefined;
  networkPlan: MicrovmNetworkPlan | undefined;
  networkNamespace: string;
}

export async function resolveCloudHypervisorStartNetworkConfig(
  context: CloudHypervisorStartContext,
  artifacts: CloudHypervisorPreflightResult,
): Promise<StartNetworkConfig | undefined> {
  const { workloadProfile } = context;
  return workloadProfile.network.mode === 'primary'
    ? {
        infrastructureBridge: workloadProfile.network.infrastructureBridge,
        enableApiProxy: workloadProfile.network.enableApiProxy,
        ...(workloadProfile.network.apiProxyIp
          ? { apiProxyIp: workloadProfile.network.apiProxyIp }
          : {}),
        ...(workloadProfile.network.controlPeer
          ? { controlPeer: workloadProfile.network.controlPeer }
          : {}),
        ...(workloadProfile.network.controlPeers
          ? { controlPeers: workloadProfile.network.controlPeers }
          : {}),
        ...(workloadProfile.network.hostAliases
          ? { hostAliases: workloadProfile.network.hostAliases }
          : {}),
      }
    : workloadProfile.kind === 'agent-enclave'
      ? await resolveCloudHypervisorEnclaveNetwork(workloadProfile, {
          docker: artifacts.tools.docker,
          ip: artifacts.tools.ip,
        }, undefined, process.env, context.launchReport?.fork('enclave-network'))
      : undefined;
}

export async function setupCloudHypervisorStartNetwork(
  context: CloudHypervisorStartContext,
  resources: CloudHypervisorStartResources,
  networkConfig: StartNetworkConfig | undefined,
  check: CloudHypervisorStartCheck,
): Promise<CloudHypervisorStartNetwork> {
  const { dependencies, paths, workloadProfile } = context;
  const { artifacts, cleanupRecord, identity } = resources;
  let networkPlan: MicrovmNetworkPlan | undefined;
  let networkNamespace: string;
  if (networkConfig) {
    if (workloadProfile.kind === 'agent-enclave') {
      const verified = await resolveCloudHypervisorEnclaveNetwork(workloadProfile, {
        docker: artifacts.tools.docker,
        ip: artifacts.tools.ip,
      }, undefined, process.env, context.launchReport?.fork('enclave-network'));
      if (verified.infrastructureBridge !== networkConfig.infrastructureBridge) {
        throw new Error('Agent-enclave Docker bridge changed before network setup');
      }
    }
    const reservation = await dependencies.reserveNetwork(paths.runId, {
      ...networkConfig,
      tapOwnerUid: identity.uid,
      tapOwnerGid: identity.gid,
      tapVnetHdr: true,
    }, artifacts.tools);
    networkPlan = reservation.plan;
    context.setNetworkPlan(networkPlan);
    try {
      await cleanupRecord.captureNetworkPlan(networkPlan);
    } catch (error) {
      try {
        await reservation.release();
      } catch (releaseError) {
        throw new Error(
          `Creating the durable cleanup record failed: ${formatError(error)}; ` +
          `releasing the network reservation also failed: ${formatError(releaseError)}`,
        );
      }
      throw error;
    }
    const network = dependencies.createNetwork(networkPlan, artifacts.tools, reservation, {
      resourceCreated: (resource) => cleanupRecord.captureNetworkResource(resource),
    });
    context.setNetwork(network);
    await check('network', () => network.setup());
    networkNamespace = networkPlan.namespaceName;
  } else {
    const namespacePlan = createCloudHypervisorEmptyNetworkNamespacePlan(paths.runId);
    await cleanupRecord.captureEmptyNetworkNamespace(namespacePlan);
    const network = dependencies.createEmptyNetworkNamespace(
      namespacePlan,
      artifacts.tools,
      { resourceCreated: (resource) => cleanupRecord.captureNetworkResource(resource) },
    );
    context.setNetwork(network);
    await check('network', () => network.setup());
    networkNamespace = namespacePlan.namespaceName;
  }
  return { networkConfig, networkPlan, networkNamespace };
}
