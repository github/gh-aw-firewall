import type { WrapperConfig } from '../types';

const ACCEPTANCE_WORKFLOW_REF =
  /^github\/gh-aw-firewall\/\.github\/workflows\/smoke-enclave-cloud-hypervisor\.lock\.yml@(refs\/tags\/v\d+\.\d+\.\d+)$/;

export function isCloudHypervisorScriptAcceptanceWorkflow(
  config: Pick<WrapperConfig, 'containerRuntime' | 'enclaves' | 'cloudHypervisor'>,
): boolean {
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'github/gh-aw-firewall'
    || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  ) {
    return false;
  }
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? '';
  const refMatch = ACCEPTANCE_WORKFLOW_REF.exec(workflowRef);
  if (
    !refMatch
    || process.env.GITHUB_REF !== refMatch[1]
    || process.env.GITHUB_REF_TYPE !== 'tag'
    || process.env.GITHUB_REF_NAME !== config.cloudHypervisor?.artifactReleaseTag
  ) {
    return false;
  }

  const enclaves = config.enclaves;
  if (
    config.containerRuntime !== 'cloud-hypervisor'
    || !enclaves?.enabled
    || !enclaves.executors.script.enabled
    || enclaves.executors.script.runtime !== 'cloud-hypervisor'
    || enclaves.executors.script.maxInvocations !== 1
    || enclaves.executors.script.image !== undefined
    || enclaves.executors.agent.enabled
    || enclaves.executors.agent.dynamic !== undefined
    || enclaves.privateRepos.length !== 1
    || enclaves.privateRepos[0].repo !== 'github/gh-aw-firewall'
    || enclaves.privateRepos[0].sensitivity !== 'public'
  ) {
    return false;
  }
  return true;
}
