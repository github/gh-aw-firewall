import { isDeepStrictEqual } from 'util';
import { releaseTag } from '../cloud-hypervisor/artifact-compatibility.json';
import { CLOUD_HYPERVISOR_CANDIDATE_COMMIT } from '../cloud-hypervisor/artifact-manifest';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';

const WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor-enclaves.yml';
const PUBLIC_REPOS = [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }];
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Admission for pinned native conformance profiles, not general enclave use. */
export function isCloudHypervisorConformanceAcceptanceWorkflow(config: WrapperConfig): boolean {
  const runtime = config.cloudHypervisor;
  const candidateCommit = CLOUD_HYPERVISOR_CANDIDATE_COMMIT;
  const candidate = candidateCommit !== undefined;
  const ref = candidate ? process.env.GITHUB_REF ?? '' : `refs/tags/${releaseTag}`;
  const sourceMatches = candidate
    ? process.env.AWF_ENCLAVE_ACCEPTANCE_MODE === 'candidate'
      && process.env.GITHUB_REF_TYPE === 'branch'
      && Boolean(process.env.GITHUB_REF_NAME)
      && ref === `refs/heads/${process.env.GITHUB_REF_NAME}`
      && process.env.GITHUB_SHA === candidateCommit
      && process.env.AWF_ACCEPTANCE_COMMIT === candidateCommit
    : process.env.GITHUB_REF_TYPE === 'tag'
      && process.env.GITHUB_REF_NAME === releaseTag
      && process.env.GITHUB_REF === ref;
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'github/gh-aw-firewall'
    || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !sourceMatches
    || process.env.GITHUB_WORKFLOW_REF !== `${WORKFLOW}@${ref}`
    || !SHA_PATTERN.test(process.env.GITHUB_SHA ?? '')
    || process.env.GITHUB_WORKFLOW_SHA !== process.env.GITHUB_SHA
    || !SHA_PATTERN.test(process.env.AWF_ACCEPTANCE_COMMIT ?? '')
    || config.containerRuntime !== 'cloud-hypervisor'
    || config.enableApiProxy === false
    || runtime?.artifactReleaseTag !== releaseTag
    || runtime.developmentAllowUnattestedArtifacts
    || runtime.sha256 !== undefined
    || !config.imageTag
  ) return false;
  try {
    const tag = parseImageTag(config.imageTag).tag;
    if ((tag.startsWith('v') ? tag : `v${tag}`) !== releaseTag) return false;
  } catch {
    return false;
  }

  const enclaves = config.enclaves;
  if (!enclaves?.enabled || !isDeepStrictEqual(enclaves.privateRepos, PUBLIC_REPOS)) return false;
  const { script, agent } = enclaves.executors;
  if (!script.enabled && !agent.enabled) return false;
  for (const executor of [script, agent].filter(entry => entry.enabled)) {
    if (
      executor.runtime !== 'cloud-hypervisor'
      || executor.image !== undefined
      || executor.cpuLimit !== '1'
      || executor.pidsLimit !== 128
      || executor.maxOutputBytes !== 8192
    ) return false;
  }
  if (script.enabled && (
    script.network !== 'none'
    || script.interpreter !== 'python3'
    || script.memoryLimit !== '512m'
    || script.tmpfsLimit !== '64m'
    || script.maxScriptBytes !== 16_384
    || !(
      (script.timeout === 120 && script.maxInvocations === 8)
      || (!agent.enabled && script.timeout === 30 && script.maxInvocations === 1)
    )
  )) return false;
  if (agent.dynamic !== undefined || agent.github !== undefined || agent.tools !== undefined) return false;
  if (agent.enabled && (
    agent.network !== 'api-proxy-only'
    || agent.engine !== 'copilot'
    || agent.profile !== 'openai'
    || agent.model !== 'gpt-4.1'
    || agent.memoryLimit !== '1g'
    || agent.tmpfsLimit !== '256m'
    || agent.timeout !== 180
    || agent.maxInvocations !== 3
    || agent.maxTaskBytes !== 4096
    || agent.maxModelRequests !== undefined
    || agent.maxModelTokens !== undefined
    || !isDeepStrictEqual(agent.repos, PUBLIC_REPOS)
  )) return false;
  return true;
}
