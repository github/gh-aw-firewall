import { isDeepStrictEqual } from 'util';
import { releaseTag } from '../cloud-hypervisor/artifact-compatibility.json';
import {
  CLOUD_HYPERVISOR_CANDIDATE_COMMIT,
  CLOUD_HYPERVISOR_REGRESSION_COMMIT,
  CLOUD_HYPERVISOR_REGRESSION_SIGNER_WORKFLOW,
} from '../cloud-hypervisor/artifact-manifest';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';

const WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor-enclaves.yml';
const PUBLIC_REPOS = [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REGRESSION_WORKFLOW_REF = `${CLOUD_HYPERVISOR_REGRESSION_SIGNER_WORKFLOW}@refs/heads/main`;

function parseGitHubOidcClaims(): Record<string, unknown> | undefined {
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = Buffer.from(b64 + pad, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function hasExpectedRegressionWorkflowIdentity(): boolean {
  const claims = parseGitHubOidcClaims();
  if (!claims) return false;
  const repository = claims.repository;
  const ref = claims.ref;
  const eventName = claims.event_name;
  const workflowRef = claims.job_workflow_ref;
  const sha = claims.sha;
  return repository === 'gh-aw-firewall'
    && ref === 'refs/heads/main'
    && (eventName === 'schedule' || eventName === 'workflow_dispatch')
    && workflowRef === REGRESSION_WORKFLOW_REF
    && sha === CLOUD_HYPERVISOR_REGRESSION_COMMIT;
}

/** Only the source-pinned daily build may exercise these public agent profiles. */
export function isCloudHypervisorDailyRegressionWorkflow(config: WrapperConfig): boolean {
  const commit = CLOUD_HYPERVISOR_REGRESSION_COMMIT;
  const runtime = config.cloudHypervisor;
  const enclaves = config.enclaves;
  if (!commit
    || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'github/gh-aw-firewall'
    || !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? '')
    || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_SHA !== commit
    || process.env.GITHUB_WORKFLOW_SHA !== commit
    || process.env.GITHUB_WORKFLOW_REF !== REGRESSION_WORKFLOW_REF
    || !hasExpectedRegressionWorkflowIdentity()
    || config.containerRuntime !== 'cloud-hypervisor'
    || config.imageTag !== commit
    || config.enableApiProxy !== true
    || runtime?.artifactReleaseTag !== `v0.0.0-regression.${commit}`
    || runtime.developmentAllowUnattestedArtifacts
    || runtime.sha256 !== undefined
    || !enclaves?.enabled || enclaves.executors.script.enabled
    || !isDeepStrictEqual(enclaves.privateRepos, PUBLIC_REPOS)) return false;
  const agent = enclaves.executors.agent;
  const profiles = {
    copilot: ['anthropic', 'claude-sonnet-5'],
    codex: ['openai', 'gpt-5.4'],
    claude: ['anthropic', 'claude-haiku-4-5'],
  };
  const profile = profiles[agent.engine as keyof typeof profiles];
  return agent.enabled && agent.runtime === 'cloud-hypervisor'
    && profile !== undefined && agent.profile === profile[0] && agent.model === profile[1]
    && agent.image === undefined && agent.dynamic === undefined
    && agent.github === undefined && agent.tools === undefined
    && agent.timeout === 360 && agent.maxInvocations === 1 && agent.maxTaskBytes === 16_384
    && agent.maxOutputBytes === 8192 && agent.cpuLimit === '1' && agent.pidsLimit === 128
    && agent.memoryLimit === '1g' && agent.tmpfsLimit === '256m'
    && agent.maxModelRequests === undefined && agent.maxModelTokens === undefined
    && isDeepStrictEqual(agent.repos, PUBLIC_REPOS);
}

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
    || agent.timeout !== 360
    || agent.maxInvocations !== 3
    || agent.maxTaskBytes !== 4096
    || agent.maxModelRequests !== undefined
    || agent.maxModelTokens !== undefined
    || !isDeepStrictEqual(agent.repos, PUBLIC_REPOS)
  )) return false;
  return true;
}
