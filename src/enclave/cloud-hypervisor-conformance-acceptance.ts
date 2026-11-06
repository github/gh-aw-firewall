import { execFileSync } from 'node:child_process';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
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
const OIDC_AUDIENCE = 'github/gh-aw-firewall';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
const OIDC_REQUEST_HOST = 'pipelines.actions.githubusercontent.com';
let regressionIdentityChecked = false;
let regressionIdentityVerified = false;

function decodeJwtSegment(segment: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const payload = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function fetchGitHubOidcToken(): string | undefined {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || typeof requestToken !== 'string'
      || !/^[A-Za-z0-9._~-]{1,4096}$/.test(requestToken)) return undefined;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'https:' || url.hostname !== OIDC_REQUEST_HOST
        || url.username || url.password || url.port || url.hash) return undefined;
    url.searchParams.set('audience', OIDC_AUDIENCE);
    const response = execFileSync('curl', [
      '--config', '-', '--proto', '=https', '--tlsv1.2',
      '--silent', '--show-error', '--fail', '--max-time', '10',
    ], {
      input: `url = "${url.toString()}"\nheader = "Authorization: bearer ${requestToken}"\n`,
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      timeout: 12_000,
    });
    const parsed: unknown = JSON.parse(response);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function verifyGitHubOidcToken(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const header = decodeJwtSegment(parts[0]);
  const claims = decodeJwtSegment(parts[1]);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return undefined;
  try {
    const response = execFileSync('curl', [
      '--proto', '=https', '--tlsv1.2', '--silent', '--show-error', '--fail', '--max-time', '10',
      OIDC_JWKS_URL,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 12_000 });
    const jwks: unknown = JSON.parse(response);
    if (!jwks || typeof jwks !== 'object' || Array.isArray(jwks)) return undefined;
    const keys = (jwks as Record<string, unknown>).keys;
    if (!Array.isArray(keys)) return undefined;
    const key = keys.find((entry: unknown): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const candidate = entry as Record<string, unknown>;
      return candidate.kid === header.kid && candidate.kty === 'RSA'
        && (candidate.use === undefined || candidate.use === 'sig')
        && (candidate.alg === undefined || candidate.alg === 'RS256');
    });
    if (!key || !verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({
        key: key as unknown as import('node:crypto').webcrypto.JsonWebKey, format: 'jwk',
      }), Buffer.from(parts[2], 'base64url'))) return undefined;
  } catch {
    return undefined;
  }
  const repository = claims.repository;
  const ref = claims.ref;
  const eventName = claims.event_name;
  const workflowRef = claims.job_workflow_ref;
  const sha = claims.sha;
  const audience = claims.aud;
  const now = Math.floor(Date.now() / 1000);
  return claims.iss === OIDC_ISSUER
    && (audience === OIDC_AUDIENCE
      || (Array.isArray(audience) && audience.includes(OIDC_AUDIENCE)))
    && typeof claims.exp === 'number' && claims.exp > now
    && (typeof claims.nbf !== 'number' || claims.nbf <= now + 60)
    && repository === 'github/gh-aw-firewall'
    && claims.repository_owner === 'github'
    && ref === 'refs/heads/main'
    && (eventName === 'schedule' || eventName === 'workflow_dispatch')
    && workflowRef === REGRESSION_WORKFLOW_REF
    && sha === CLOUD_HYPERVISOR_REGRESSION_COMMIT ? claims : undefined;
}

function hasExpectedRegressionWorkflowIdentity(): boolean {
  if (regressionIdentityChecked) return regressionIdentityVerified;
  regressionIdentityChecked = true;
  const token = fetchGitHubOidcToken();
  regressionIdentityVerified = token !== undefined && verifyGitHubOidcToken(token) !== undefined;
  return regressionIdentityVerified;
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
    || config.enableApiProxy === false
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
