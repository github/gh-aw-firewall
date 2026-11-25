import * as fs from 'fs';
import type { WrapperConfig } from '../types';
import { resolveEnclaveAgentGithubAllowedTools } from '../types/enclave-options';
import {
  ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
  ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV,
  ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
} from './gateway';
import { ENCLAVE_AGENT_GITHUB_MCP_IP, ENCLAVE_GITHUB_MCP_PORT } from './network';
import { resolveEnclavePaths } from './paths';
import { ENCLAVE_GITHUB_MCP_AGENT_ID_ENV, getStaticGithubExecutorCapability } from './static-github-handoff';

export const ENCLAVE_GITHUB_MCP_SERVER_NAME = 'github';
export const ENCLAVE_GITHUB_MCP_INTERNAL_URL =
  `http://${ENCLAVE_AGENT_GITHUB_MCP_IP}:${ENCLAVE_GITHUB_MCP_PORT}/mcp/${ENCLAVE_GITHUB_MCP_SERVER_NAME}`;

export interface EnclaveGithubGatewayContract {
  /**
   * Compiler-issued static identity for the `issues-read-v1` profile.
   *
   * Dynamic entries have no static identity: gh-aw mints
   * `AWF_ENCLAVE_GITHUB_MCP_AGENT_ID` only for the static profile, and a
   * dynamic executor authenticates with a per-invocation delegated bearer
   * instead. It is therefore absent in `dynamic` mode.
   */
  agentId?: string;
  /** Which enclave GitHub route this run needs from the shared gateway. */
  mode: 'static' | 'dynamic';
  containerName: string;
  endpoint: URL;
  identity: string;
  /** Closed set of tool names readiness must find, and only find, on the gateway. */
  allowedTools: string[];
}

/**
 * Whether this run needs the shared gateway's enclave GitHub route.
 *
 * Two independent shapes need it: the static `issues-read-v1` profile, and a
 * dynamic entry whose per-invocation delegated identities reach the same
 * `github` backend (gh-aw keeps that backend registered for exactly this
 * reason, while withholding it from the primary agent).
 */
export function isEnclaveGithubEnabled(config: WrapperConfig): boolean {
  return isEnclaveStaticGithubEnabled(config) || isEnclaveDynamicGithubEnabled(config);
}

function isEnclaveStaticGithubEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && config.enclaves.executors.agent.enabled
    && resolveEnclaveAgentGithubAllowedTools(config.enclaves.executors.agent) !== undefined;
}

function isEnclaveDynamicGithubEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && config.enclaves.executors.agent.enabled
    && config.enclaves.executors.agent.dynamic !== undefined;
}

function requiredIdentity(name: string, value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function resolveGithubEndpoint(rawEndpoint: string | undefined): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint ?? '');
  } catch {
    throw new Error(`${ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV} is missing or invalid`);
  }

  if (
    endpoint.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error(`${ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV} must be a loopback HTTP endpoint`);
  }
  endpoint.pathname = `/mcp/${ENCLAVE_GITHUB_MCP_SERVER_NAME}`;
  return endpoint;
}

function resolveGithubAgentId(config: WrapperConfig, env: NodeJS.ProcessEnv): string | undefined {
  const capability = getStaticGithubExecutorCapability(config);
  if (capability) return capability.agentId;
  if (env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV]) {
    return env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV];
  }
  const agentIdPath = resolveEnclavePaths(config.workDir).githubAgentIdPath;
  let fd: number | undefined;
  try {
    fd = fs.openSync(agentIdPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return undefined;
    return fs.readFileSync(fd, 'ascii').trim();
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function resolveEnclaveGithubGatewayContract(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnclaveGithubGatewayContract {
  if (!isEnclaveGithubEnabled(config)) {
    throw new Error('Enclave GitHub gateway contract requested while issues-read-v1 is disabled');
  }
  const dynamic = config.enclaves?.executors.agent.dynamic;
  const staticTools = resolveEnclaveAgentGithubAllowedTools(config.enclaves?.executors.agent);
  const allowedTools = staticTools ?? dynamic?.githubPolicy.tools;
  if (!allowedTools || allowedTools.length === 0) {
    throw new Error('Enclave GitHub gateway contract requires a non-empty configured tool allowlist');
  }
  const mode: 'static' | 'dynamic' = staticTools ? 'static' : 'dynamic';
  return {
    // A dynamic-only entry has no compiler-issued static identity; the
    // executor authenticates per invocation with a delegated bearer that AWF
    // mints through the private control channel.
    ...(mode === 'static'
      ? {
        agentId: requiredIdentity(
          ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
          resolveGithubAgentId(config, env),
        ),
      }
      : {}),
    mode,
    containerName: requiredIdentity(
      ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
      env[ENCLAVE_MCP_GATEWAY_CONTAINER_ENV],
    ),
    endpoint: resolveGithubEndpoint(env[ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV]),
    identity: requiredIdentity(
      ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
      env[ENCLAVE_MCP_GATEWAY_IDENTITY_ENV],
    ),
    allowedTools: [...allowedTools].sort(),
  };
}
