import * as fs from 'fs';
import * as http from 'http';
import execa from 'execa';
import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import { resolveEnclaveAgentGithubAllowedTools } from '../types/enclave-options';
import {
  ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
  ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV,
  ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
  ENCLAVE_MCP_READINESS_TIMEOUT_ENV,
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
} from './gateway';
import {
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
  ENCLAVE_GITHUB_MCP_ALIAS,
} from './network';
import { resolveEnclavePaths } from './paths';

export const ENCLAVE_GITHUB_MCP_AGENT_ID_ENV = 'AWF_ENCLAVE_GITHUB_MCP_AGENT_ID';
export const ENCLAVE_GITHUB_MCP_PORT = 8080;
export const ENCLAVE_GITHUB_MCP_SERVER_NAME = 'github';
export const ENCLAVE_GITHUB_MCP_INTERNAL_URL =
  `http://${ENCLAVE_AGENT_GITHUB_MCP_IP}:${ENCLAVE_GITHUB_MCP_PORT}/mcp/${ENCLAVE_GITHUB_MCP_SERVER_NAME}`;

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 500;
const MAX_RESPONSE_BYTES = 256 * 1024;

class GithubGatewayReadinessError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

interface EnclaveGithubGatewayContract {
  agentId: string;
  containerName: string;
  endpoint: URL;
  identity: string;
  /** Closed set of tool names readiness must find, and only find, on the gateway. */
  allowedTools: string[];
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isEnclaveGithubEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && config.enclaves.executors.agent.enabled
    && resolveEnclaveAgentGithubAllowedTools(config.enclaves.executors.agent) !== undefined;
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
  const allowedTools = resolveEnclaveAgentGithubAllowedTools(config.enclaves?.executors.agent);
  if (!allowedTools || allowedTools.length === 0) {
    throw new Error('Enclave GitHub gateway contract requires a non-empty configured tool allowlist');
  }
  return {
    agentId: requiredIdentity(
      ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
      resolveGithubAgentId(config, env),
    ),
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

async function inspectSharedGateway(contract: EnclaveGithubGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted shared MCP gateway container is unavailable');
  }
  let inspected: {
    Name?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    HostConfig?: { NetworkMode?: string };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Trusted shared MCP gateway identity could not be inspected');
  }
  if (
    inspected.Name !== `/${contract.containerName}`
    || inspected.State?.Running !== true
    || inspected.Config?.Labels?.[ENCLAVE_MCP_GATEWAY_RUN_LABEL] !== contract.identity
    || inspected.HostConfig?.NetworkMode !== 'bridge'
  ) {
    throw new Error('Trusted shared MCP gateway did not match the compiler handoff');
  }
}

async function assertAgentNetworkMembership(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['network', 'inspect', '--format', '{{json .}}', ENCLAVE_AGENT_NETWORK],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Enclave agent network is unavailable');
  }
  let network: {
    Internal?: boolean;
    Driver?: string;
    IPAM?: { Config?: Array<{ Subnet?: string }> };
    Containers?: Record<string, { Name?: string }>;
  };
  try {
    network = JSON.parse(result.stdout);
  } catch {
    throw new Error('Enclave agent network membership could not be inspected');
  }
  const subnetConfig = network.IPAM?.Config ?? [];
  if (
    network.Internal !== true
    || network.Driver !== 'bridge'
    || subnetConfig.length !== 1
    || subnetConfig[0]?.Subnet !== ENCLAVE_AGENT_SUBNET
  ) {
    throw new Error('Enclave agent network is not the fixed isolated bridge');
  }
  const names = Object.values(network.Containers ?? {})
    .map((entry) => entry.Name)
    .filter(Boolean)
    .sort();
  const expected = [ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME, contract.containerName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('Enclave agent network contains an unexpected steady-state member');
  }
}

async function assertSharedGatewayAttachment(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Shared MCP gateway network attachment is unavailable');
  }
  let inspected: {
    NetworkSettings?: {
      Networks?: Record<string, { Aliases?: string[] | null; IPAddress?: string }>;
    };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Shared MCP gateway network attachment could not be inspected');
  }
  const attachment = inspected.NetworkSettings?.Networks?.[ENCLAVE_AGENT_NETWORK];
  if (
    !Array.isArray(attachment?.Aliases)
    || !attachment.Aliases.includes(ENCLAVE_GITHUB_MCP_ALIAS)
    || attachment.IPAddress !== ENCLAVE_AGENT_GITHUB_MCP_IP
  ) {
    throw new Error('Shared MCP gateway is missing its fixed enclave attachment');
  }
}

function postJsonRpc(
  endpoint: URL,
  agentId: string,
  message: Record<string, unknown>,
  sessionId?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ body: JsonRpcResponse; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const rejectBounded = (error: Error): void => {
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: agentId,
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new GithubGatewayReadinessError(
            'Shared MCP gateway response exceeded its framing bound',
          ));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200 && response.statusCode !== 202) {
            if (response.statusCode === 503) {
              try {
                const unavailable = JSON.parse(raw) as {
                  error?: unknown;
                  retryable?: unknown;
                };
                if (
                  unavailable.error === 'backend_unavailable'
                  && unavailable.retryable !== false
                ) {
                  rejectBounded(new GithubGatewayReadinessError(
                    'Shared MCP gateway backend is not yet available',
                    true,
                  ));
                  return;
                }
              } catch {
                // Treat every undocumented response shape as a terminal failure.
              }
            }
            rejectBounded(new GithubGatewayReadinessError('Shared MCP gateway request failed'));
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '');
          const events = raw
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .filter(line => line !== '' && line !== '[DONE]');
          const jsonText = contentType.includes('text/event-stream')
            ? events[events.length - 1]
            : raw;
          const returnedSession = response.headers['mcp-session-id'];
          clearTimeout(deadlineTimer);
          resolve({
            body: !jsonText ? {} : JSON.parse(jsonText) as JsonRpcResponse,
            sessionId: typeof returnedSession === 'string' ? returnedSession : sessionId,
          });
        } catch {
          rejectBounded(new GithubGatewayReadinessError(
            'Shared MCP gateway returned invalid bounded JSON',
          ));
        }
      });
    });
    request.on('timeout', () => request.destroy(
      new GithubGatewayReadinessError('Shared MCP gateway request timed out'),
    ));
    request.on('error', rejectBounded);
    const deadlineTimer = setTimeout(() => request.destroy(
      new GithubGatewayReadinessError('Shared MCP gateway request timed out'),
    ), timeoutMs);
    request.end(payload);
  });
}

export async function connectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  await inspectSharedGateway(contract);
  const result = await execa(
    'docker',
    [
      'network',
      'connect',
      '--ip',
      ENCLAVE_AGENT_GITHUB_MCP_IP,
      '--alias',
      ENCLAVE_GITHUB_MCP_ALIAS,
      ENCLAVE_AGENT_NETWORK,
      contract.containerName,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (
    result.exitCode !== 0
    && !/already exists in network|is already attached|already connected/i.test(result.stderr || '')
  ) {
    throw new Error('Failed to attach the shared MCP gateway to the enclave agent network');
  }
  await assertAgentNetworkMembership(contract);
  await assertSharedGatewayAttachment(contract);
}

async function proveGithubGatewayReadiness(
  contract: EnclaveGithubGatewayContract,
  deadline: number,
): Promise<void> {
  const requestBudget = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GithubGatewayReadinessError('Readiness deadline expired');
    return Math.min(REQUEST_TIMEOUT_MS, remaining);
  };
  await assertAgentNetworkMembership(contract);
  await assertSharedGatewayAttachment(contract);
  const initialized = await postJsonRpc(contract.endpoint, contract.agentId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'awf-enclave-readiness', version: '1.0.0' },
    },
  }, undefined, requestBudget());
  if (
    initialized.body.error !== undefined
    || initialized.body.id !== 1
    || !initialized.sessionId
  ) {
    throw new Error('Shared MCP gateway rejected the enclave identity');
  }
  await postJsonRpc(contract.endpoint, contract.agentId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }, initialized.sessionId, requestBudget());
  const tools = await listAllGithubGatewayTools(contract, initialized.sessionId, requestBudget);
  if (JSON.stringify(tools) !== JSON.stringify(contract.allowedTools)) {
    throw new Error('Shared MCP gateway did not expose exactly the configured allowed tools');
  }
}

/** Bounds `tools/list` pagination so a misbehaving gateway cannot stall readiness. */
const MAX_TOOLS_LIST_PAGES = 20;

/**
 * Consumes every `tools/list` page (MCP 2025-06-18 permits `nextCursor`) and
 * rejects the whole response if any page errors, is malformed, or contains a
 * malformed tool entry, so a partially valid first page can never mask extra
 * or invalid tools advertised elsewhere in the pagination.
 */
async function listAllGithubGatewayTools(
  contract: EnclaveGithubGatewayContract,
  sessionId: string,
  requestBudget: () => number,
): Promise<string[]> {
  const tools: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_TOOLS_LIST_PAGES) {
      throw new Error('Shared MCP gateway returned too many tools/list pages');
    }
    const listed = await postJsonRpc(contract.endpoint, contract.agentId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: cursor === undefined ? {} : { cursor },
    }, sessionId, requestBudget());
    if (listed.body.error !== undefined) {
      throw new Error('Shared MCP gateway rejected the tools/list request');
    }
    const result = listed.body.result;
    if (
      !result
      || typeof result !== 'object'
      || !('tools' in result)
      || !Array.isArray(result.tools)
    ) {
      throw new Error('Shared MCP gateway returned a malformed tools/list response');
    }
    for (const tool of result.tools) {
      if (
        !tool
        || typeof tool !== 'object'
        || !('name' in tool)
        || typeof tool.name !== 'string'
        || tool.name === ''
      ) {
        throw new Error('Shared MCP gateway returned a malformed tools/list entry');
      }
      tools.push(tool.name);
    }
    const nextCursor = 'nextCursor' in result ? result.nextCursor : undefined;
    if (nextCursor === undefined) break;
    if (typeof nextCursor !== 'string' || nextCursor === '') {
      throw new Error('Shared MCP gateway returned a malformed tools/list nextCursor');
    }
    cursor = nextCursor;
  }
  return tools.sort();
}

export async function assertEnclaveGithubGatewayReady(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  const configuredTimeout = Number(env[ENCLAVE_MCP_READINESS_TIMEOUT_ENV]
    ?? DEFAULT_READINESS_TIMEOUT_MS);
  const readinessTimeout = timeoutMs ?? configuredTimeout;
  if (
    !Number.isSafeInteger(readinessTimeout)
    || readinessTimeout < 1_000
    || readinessTimeout > 600_000
  ) {
    throw new Error(`${ENCLAVE_MCP_READINESS_TIMEOUT_ENV} must be between 1000 and 600000`);
  }
  const deadline = Date.now() + readinessTimeout;
  let lastError: unknown;
  do {
    try {
      await proveGithubGatewayReadiness(contract, deadline);
      return;
    } catch (error) {
      if (!(error instanceof GithubGatewayReadinessError) || !error.retryable) throw error;
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_DELAY_MS, remaining)));
      }
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Enclave GitHub MCP readiness timed out before primary-agent startup: ${
      lastError instanceof Error ? lastError.message : 'unknown readiness failure'
    }`,
  );
}

export async function disconnectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config) || config.keepContainers) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  const result = await execa(
    'docker',
    ['network', 'disconnect', '-f', ENCLAVE_AGENT_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Failed to disconnect the shared MCP gateway from the enclave agent network');
  }
}

export const enclaveGithubGatewayTestHelpers = {
  assertAgentNetworkMembership,
  assertSharedGatewayAttachment,
  inspectSharedGateway,
  postJsonRpc,
};
