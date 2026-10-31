import type { WrapperConfig } from '../types';
import { resolveEnclaveAgentGithubAllowedTools } from '../types/enclave-options';
import { ENCLAVE_MCP_GATEWAY_IDENTITY_ENV } from './gateway';
import {
  assertNoHostGithubTokenValue,
  GITHUB_TOKEN_ENV_VARS,
  getGithubTokenEnvValues,
} from '../services/agent-environment/github-token-isolation';

export const ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV = 'AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY';
export const ENCLAVE_GITHUB_MCP_AGENT_ID_ENV = 'AWF_ENCLAVE_GITHUB_MCP_AGENT_ID';
const MAX_LIFETIME_MS = 60 * 60 * 1000;

export interface StaticGithubExecutorCapability {
  readonly version: 1;
  readonly gatewayIdentity: string;
  readonly executor: 'agent';
  readonly agentId: string;
  readonly bearer: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly allowedTools: readonly string[];
  readonly allowedRepos: readonly string[];
  readonly minIntegrity: string | null;
}

const capabilities = new WeakMap<WrapperConfig, StaticGithubExecutorCapability>();

function required(config: WrapperConfig): boolean {
  const agent = config.enclaves?.executors.agent;
  return agent?.enabled === true && agent.runtime === 'cloud-hypervisor'
    && resolveEnclaveAgentGithubAllowedTools(agent) !== undefined;
}

function sameSet(actual: unknown, expected: readonly string[]): actual is string[] {
  return Array.isArray(actual) && actual.every((value) => typeof value === 'string')
    && new Set(actual).size === actual.length
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/** Take custody before spawning any process; the compiler and gateway own issuance and enforcement. */
export function takeStaticGithubExecutorCapability(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): void {
  const raw = env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV];
  delete env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV];
  if (!required(config)) return;
  if (raw === undefined && capabilities.has(config)) return;
  capabilities.delete(config);
  const fail = (): never => {
    capabilities.delete(config);
    throw new Error('Cloud Hypervisor GitHub tools require a valid compiler-scoped executor capability; '
      + 'AWF never substitutes a static identity or gateway-wide key');
  };
  if (!raw || Buffer.byteLength(raw, 'utf8') > 64 * 1024) fail();
  let value: StaticGithubExecutorCapability;
  try {
    value = JSON.parse(raw!);
  } catch {
    return fail();
  }
  const agent = config.enclaves!.executors.agent;
  const tools = resolveEnclaveAgentGithubAllowedTools(agent)!;
  const repos = (agent.tools?.github?.allowedRepos
    ?? config.enclaves!.privateRepos.map(({ repo }) => repo)).map((repo) => repo.toLowerCase());
  const fields = ['version', 'gatewayIdentity', 'executor', 'agentId', 'bearer',
    'issuedAt', 'expiresAt', 'allowedTools', 'allowedRepos', 'minIntegrity'];
  if (!value || typeof value !== 'object'
    || Object.keys(value).length !== fields.length
    || Object.keys(value).some((field) => !fields.includes(field))
    || value.version !== 1 || value.executor !== 'agent'
    || typeof value.gatewayIdentity !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(value.gatewayIdentity)
    || value.gatewayIdentity !== env[ENCLAVE_MCP_GATEWAY_IDENTITY_ENV]
    || typeof value.agentId !== 'string'
    || !/^[A-Za-z0-9_-]{32,128}$/.test(value.agentId)
    || value.agentId !== env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV]
    || typeof value.bearer !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(value.bearer)
    || /^(?:github_pat_|gh[pousr]_)/.test(value.bearer)
    || value.bearer === value.agentId || value.bearer === env.MCP_GATEWAY_API_KEY
    || value.bearer === process.env.MCP_GATEWAY_API_KEY
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt > now || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_LIFETIME_MS
    || !sameSet(value.allowedTools, tools) || !sameSet(value.allowedRepos, repos)
    || value.minIntegrity !== (agent.tools?.github?.minIntegrity ?? null)) {
    fail();
  }
  assertNoHostGithubTokenValue(value.bearer, [
    ...getGithubTokenEnvValues(), ...GITHUB_TOKEN_ENV_VARS.map((name) => env[name]),
    env.MCP_GATEWAY_API_KEY, process.env.MCP_GATEWAY_API_KEY,
  ], 'Cloud Hypervisor scoped GitHub capability');
  capabilities.set(config, Object.freeze({
    ...value,
    allowedTools: Object.freeze([...value.allowedTools]),
    allowedRepos: Object.freeze([...value.allowedRepos]),
  }));
}

export function getStaticGithubExecutorCapability(
  config: WrapperConfig,
  now = Date.now(),
): StaticGithubExecutorCapability | undefined {
  if (!required(config)) return undefined;
  const capability = capabilities.get(config);
  if (!capability || capability.expiresAt <= now) {
    throw new Error('Cloud Hypervisor scoped GitHub executor capability is missing or expired');
  }
  return capability;
}

export function releaseStaticGithubExecutorCapability(config: WrapperConfig): void {
  capabilities.delete(config);
}
