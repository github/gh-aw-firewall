import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';

const ACCEPTANCE_WORKFLOW_PATH =
  'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor.lock.yml';

const TAG_REF_PATTERN = /^refs\/tags\/(v\d+\.\d+\.\d+)$/;
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isCloudHypervisorScriptAcceptanceWorkflow(
  config: Pick<WrapperConfig, 'containerRuntime' | 'enclaves' | 'cloudHypervisor' | 'imageTag'>,
): boolean {
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'github/gh-aw-firewall'
    || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  ) {
    return false;
  }

  const cloudHypervisor = config.cloudHypervisor;
  const artifactReleaseTag = cloudHypervisor?.artifactReleaseTag;
  if (!artifactReleaseTag || !RELEASE_TAG_PATTERN.test(artifactReleaseTag)) {
    return false;
  }

  if (
    cloudHypervisor?.developmentAllowUnattestedArtifacts
    || cloudHypervisor?.sha256
  ) {
    return false;
  }

  if (config.imageTag !== undefined) {
    try {
      const parsedImage = parseImageTag(config.imageTag);
      const normalizedImageTag = parsedImage.tag.startsWith('v')
        ? parsedImage.tag
        : `v${parsedImage.tag}`;
      if (normalizedImageTag !== artifactReleaseTag) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const ref = process.env.GITHUB_REF ?? '';
  const refType = process.env.GITHUB_REF_TYPE ?? '';
  const refName = process.env.GITHUB_REF_NAME ?? '';
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  const workflowSha = process.env.GITHUB_WORKFLOW_SHA;

  if (workflowSha !== undefined && !SHA_PATTERN.test(workflowSha)) {
    return false;
  }
  if (workflowSha !== undefined && sha && workflowSha !== sha) {
    return false;
  }

  const isTaggedAcceptance =
    refType === 'tag'
    && refName === artifactReleaseTag
    && TAG_REF_PATTERN.test(ref)
    && ref === `refs/tags/${refName}`
    && workflowRef === `${ACCEPTANCE_WORKFLOW_PATH}@${ref}`;

  const isMainAcceptance =
    refType === 'branch'
    && refName === 'main'
    && ref === 'refs/heads/main'
    && SHA_PATTERN.test(sha)
    && (workflowSha === undefined || workflowSha === sha)
    && (
      workflowRef === `${ACCEPTANCE_WORKFLOW_PATH}@refs/heads/main`
      || workflowRef === `${ACCEPTANCE_WORKFLOW_PATH}@${sha}`
    );

  if (!isTaggedAcceptance && !isMainAcceptance) {
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
