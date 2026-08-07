import * as http from 'http';
import * as https from 'https';
import execa from 'execa';
import { TIMING_BUCKETS_MS } from '../bounded-execution';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_MCP_CONTROL_NETWORK,
} from './network';

export const ENCLAVE_MCP_CAPABILITY_ENV = 'AWF_ENCLAVE_MCP_CAPABILITY';
export const ENCLAVE_MCP_GATEWAY_CONTAINER_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_CONTAINER';
export const ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT';
export const ENCLAVE_MCP_GATEWAY_IDENTITY_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY';
export const ENCLAVE_MCP_READINESS_TIMEOUT_ENV = 'AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS';
export const ENCLAVE_MCP_GATEWAY_RUN_LABEL = 'com.github.gh-aw.mcpg.run';
export const ENCLAVE_MCP_SERVER_NAME = 'awf-enclave';
export const ENCLAVE_MCP_UPSTREAM_URL = 'http://awf-enclave-mcp:8080/mcp';

const DEFAULT_GATEWAY_CONTAINER = 'awmg-mcpg';
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 500;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS = Math.max(...TIMING_BUCKETS_MS) / 1_000 + 30;

interface EnclaveGatewayContract {
  capability: string;
  containerName: string;
  endpoint: URL;
  identity: string;
  expectedTools: ReadonlyArray<Record<string, unknown>>;
  readinessTimeoutMs: number;
}

export interface EnclaveMcpgUpstreamContract {
  name: typeof ENCLAVE_MCP_SERVER_NAME;
  server: {
    type: 'http';
    url: typeof ENCLAVE_MCP_UPSTREAM_URL;
    headers: { Authorization: string };
    tools: string[];
    connectTimeout: number;
    toolTimeout: number;
  };
  handoff: {
    capabilityEnv: typeof ENCLAVE_MCP_CAPABILITY_ENV;
    gatewayContainerEnv: typeof ENCLAVE_MCP_GATEWAY_CONTAINER_ENV;
    gatewayEndpointEnv: typeof ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV;
    gatewayIdentityEnv: typeof ENCLAVE_MCP_GATEWAY_IDENTITY_ENV;
    readinessTimeoutEnv: typeof ENCLAVE_MCP_READINESS_TIMEOUT_ENV;
    gatewayRunLabel: typeof ENCLAVE_MCP_GATEWAY_RUN_LABEL;
  };
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

class GatewayReadinessError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'GatewayReadinessError';
  }
}

const finiteSchemaInput = {
  type: 'object',
  description: 'An AWF finite-disclosure schema (const, boolean, enum, integer, object, tuple, array, or union).',
};

const outputSchema = {
  type: 'object',
  properties: {
    status: { enum: ['ok', 'error'] },
    result: {},
  },
  required: ['status'],
  additionalProperties: false,
};

const scriptTool = {
  name: 'enclave_run_script',
  description: 'Run a bounded script against one configured private repository and return one finite value.',
  inputSchema: {
    type: 'object',
    properties: {
      privateRepo: { type: 'string', description: 'Bare configured owner/repository selector.' },
      schema: finiteSchemaInput,
      script: { type: 'string', description: 'Bounded UTF-8 Python source.' },
    },
    required: ['privateRepo', 'schema', 'script'],
    additionalProperties: false,
  },
  outputSchema,
};

const agentTool = {
  name: 'enclave_run_agent',
  description:
    'Run a bounded, single-use agent enclave against one configured private repository and return one finite value.',
  inputSchema: {
    type: 'object',
    properties: {
      privateRepo: { type: 'string', description: 'Bare configured owner/repository selector.' },
      schema: finiteSchemaInput,
      prompt: { type: 'string', description: 'Bounded UTF-8 task prompt.' },
    },
    required: ['privateRepo', 'schema', 'prompt'],
    additionalProperties: false,
  },
  outputSchema,
};

function expectedTools(config: WrapperConfig): ReadonlyArray<Record<string, unknown>> {
  const tools: Record<string, unknown>[] = [];
  if (config.enclaves?.executors.script.enabled) tools.push(scriptTool);
  if (config.enclaves?.executors.agent.enabled) tools.push(agentTool);
  return tools;
}

/**
 * Machine-readable compiler handoff. This intentionally contains only the
 * static upstream route and environment-variable names, never the capability.
 */
export function buildEnclaveMcpgUpstreamContract(config: WrapperConfig): EnclaveMcpgUpstreamContract {
  if (!config.enclaves?.enabled) {
    throw new Error('Cannot build an mcpg upstream contract while enclaves are disabled');
  }
  return {
    name: ENCLAVE_MCP_SERVER_NAME,
    server: {
      type: 'http',
      url: ENCLAVE_MCP_UPSTREAM_URL,
      headers: { Authorization: 'Bearer ' + '$' + `{${ENCLAVE_MCP_CAPABILITY_ENV}}` },
      tools: expectedTools(config).map((tool) => String(tool.name)),
      connectTimeout: 120,
      toolTimeout: ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS,
    },
    handoff: {
      capabilityEnv: ENCLAVE_MCP_CAPABILITY_ENV,
      gatewayContainerEnv: ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
      gatewayEndpointEnv: ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV,
      gatewayIdentityEnv: ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
      readinessTimeoutEnv: ENCLAVE_MCP_READINESS_TIMEOUT_ENV,
      gatewayRunLabel: ENCLAVE_MCP_GATEWAY_RUN_LABEL,
    },
  };
}

export function resolveEnclaveGatewayContract(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnclaveGatewayContract {
  if (!config.enclaves?.enabled) {
    throw new Error('Enclave gateway contract requested while enclaves are disabled');
  }
  const capability = env[ENCLAVE_MCP_CAPABILITY_ENV] ?? '';
  const identity = env[ENCLAVE_MCP_GATEWAY_IDENTITY_ENV] ?? '';
  const containerName = env[ENCLAVE_MCP_GATEWAY_CONTAINER_ENV] || DEFAULT_GATEWAY_CONTAINER;
  const endpointRaw = env[ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV] ?? '';
  const timeoutRaw = env[ENCLAVE_MCP_READINESS_TIMEOUT_ENV];

  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw new Error(`${ENCLAVE_MCP_CAPABILITY_ENV} must contain a run-scoped 256-bit lowercase hex capability`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(identity)) {
    throw new Error(`${ENCLAVE_MCP_GATEWAY_IDENTITY_ENV} is missing or invalid`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error(`${ENCLAVE_MCP_GATEWAY_CONTAINER_ENV} is invalid`);
  }
  const readinessTimeoutMs = timeoutRaw === undefined
    ? DEFAULT_READINESS_TIMEOUT_MS
    : Number(timeoutRaw);
  if (
    !Number.isSafeInteger(readinessTimeoutMs)
    || readinessTimeoutMs < 1_000
    || readinessTimeoutMs > 600_000
  ) {
    throw new Error(`${ENCLAVE_MCP_READINESS_TIMEOUT_ENV} must be between 1000 and 600000`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    throw new Error(`${ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV} must be an absolute HTTP readiness URL`);
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol)
    || !endpoint.pathname.endsWith(`/mcp/${ENCLAVE_MCP_SERVER_NAME}`)
    || endpoint.username
    || endpoint.password
  ) {
    throw new Error(
      `${ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV} must address the gateway route /mcp/${ENCLAVE_MCP_SERVER_NAME}`,
    );
  }

  return {
    capability,
    containerName,
    endpoint,
    identity,
    expectedTools: expectedTools(config),
    readinessTimeoutMs,
  };
}

async function inspectGateway(contract: EnclaveGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted enclave MCP gateway container is unavailable');
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
    throw new Error('Trusted enclave MCP gateway identity could not be inspected');
  }
  if (
    inspected.Name !== `/${contract.containerName}`
    || inspected.State?.Running !== true
    || inspected.Config?.Labels?.[ENCLAVE_MCP_GATEWAY_RUN_LABEL] !== contract.identity
    || inspected.HostConfig?.NetworkMode !== 'bridge'
  ) {
    throw new Error('Trusted enclave MCP gateway identity did not match the compiler handoff');
  }
}

async function assertControlNetworkMembership(contract: EnclaveGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['network', 'inspect', '--format', '{{json .Containers}}', ENCLAVE_MCP_CONTROL_NETWORK],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Enclave MCP control network is unavailable');
  }
  let containers: Record<string, { Name?: string }>;
  try {
    containers = JSON.parse(result.stdout);
  } catch {
    throw new Error('Enclave MCP control network membership could not be inspected');
  }
  const names = Object.values(containers).map((entry) => entry.Name).filter(Boolean).sort();
  const expected = [ENCLAVE_MCP_SERVER_CONTAINER_NAME, contract.containerName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('Enclave MCP control network contains an unexpected member');
  }
}

export async function connectEnclaveGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const contract = resolveEnclaveGatewayContract(config, env);
  await inspectGateway(contract);
  const connected = await execa(
    'docker',
    ['network', 'connect', ENCLAVE_MCP_CONTROL_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (
    connected.exitCode !== 0
    && !/already exists in network|is already attached|already connected/i.test(connected.stderr || '')
  ) {
    throw new Error('Failed to attach the trusted enclave MCP gateway to its private control network');
  }
  await assertControlNetworkMembership(contract);
}

function postJsonRpc(
  endpoint: URL,
  body: Record<string, unknown>,
  timeoutMs: number,
  sessionId?: string,
): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const resolveBounded = (value: { response: JsonRpcResponse; sessionId?: string }): void => {
      clearTimeout(deadlineTimer);
      resolve(value);
    };
    const rejectBounded = (error: Error): void => {
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 256 * 1024) {
          request.destroy(new Error('Gateway readiness response exceeded its framing bound'));
          return;
        }
        chunks.push(chunk);
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
                  && unavailable.retryable === true
                ) {
                  rejectBounded(new GatewayReadinessError(
                    'Gateway backend is not yet available',
                    true,
                  ));
                  return;
                }
              } catch {
                // The response is permanent unless it matches the documented recovery shape.
              }
            }
            rejectBounded(new GatewayReadinessError('Gateway readiness request failed'));
            return;
          }
          const contentType = String(response.headers['content-type'] ?? '');
          const events = raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter((line) => line !== '' && line !== '[DONE]');
          const jsonText = contentType.includes('text/event-stream')
            ? events[events.length - 1]
            : raw;
          const parsed = !jsonText ? {} : JSON.parse(jsonText) as JsonRpcResponse;
          const returnedSession = response.headers['mcp-session-id'];
          resolveBounded({
            response: parsed,
            sessionId: typeof returnedSession === 'string' ? returnedSession : sessionId,
          });
        } catch {
          rejectBounded(new GatewayReadinessError(
            'Gateway readiness response was not bounded JSON',
          ));
        }
      });
    });
    request.on('timeout', () => request.destroy(
      new GatewayReadinessError('Gateway readiness request timed out'),
    ));
    request.on('error', rejectBounded);
    const deadlineTimer = setTimeout(() => request.destroy(
      new GatewayReadinessError('Gateway readiness request timed out'),
    ), timeoutMs);
    request.end(payload);
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'undefined';
}

function canonicalToolSet(value: unknown): string {
  if (!Array.isArray(value)) return 'invalid';
  const names = value.map((tool) => (
    tool && typeof tool === 'object' ? (tool as Record<string, unknown>).name : undefined
  ));
  if (
    names.some((name) => typeof name !== 'string')
    || new Set(names).size !== names.length
  ) {
    return 'invalid';
  }
  return canonicalJson([...value].sort((left, right) => (
    String((left as Record<string, unknown>).name)
      .localeCompare(String((right as Record<string, unknown>).name))
  )));
}

function remainingRequestBudget(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new GatewayReadinessError('Gateway readiness deadline expired');
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

async function proveGatewayReadiness(
  contract: EnclaveGatewayContract,
  deadline: number,
): Promise<void> {
  const initialized = await postJsonRpc(contract.endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'awf-readiness', version: '1.0.0' },
    },
  }, remainingRequestBudget(deadline));
  const result = initialized.response.result as { serverInfo?: { name?: string } } | undefined;
  if (initialized.response.error || result?.serverInfo?.name !== 'awf-enclave') {
    throw new Error('Gateway initialize proof did not reach the AWF enclave server');
  }
  await postJsonRpc(contract.endpoint, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }, remainingRequestBudget(deadline), initialized.sessionId);
  const listed = await postJsonRpc(contract.endpoint, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, remainingRequestBudget(deadline), initialized.sessionId);
  const tools = (listed.response.result as { tools?: unknown })?.tools;
  if (canonicalToolSet(tools) !== canonicalToolSet(contract.expectedTools)) {
    throw new Error('Gateway enclave tool contract did not exactly match the enabled executors');
  }
}

export async function assertEnclaveGatewayReady(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<void> {
  const contract = resolveEnclaveGatewayContract(config, env);
  const deadline = Date.now() + (timeoutMs ?? contract.readinessTimeoutMs);
  let lastError: unknown;
  do {
    try {
      await proveGatewayReadiness(contract, deadline);
      return;
    } catch (error) {
      if (!(error instanceof GatewayReadinessError) || !error.retryable) {
        throw error;
      }
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_DELAY_MS, remaining)));
      }
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Enclave MCP gateway readiness timed out before primary-agent startup: ${
      lastError instanceof Error ? lastError.message : 'unknown readiness failure'
    }`,
  );
}

export async function shutdownEnclaveGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!config.enclaves?.enabled || config.keepContainers) return;
  const contract = resolveEnclaveGatewayContract(config, env);
  const drainTimeoutSeconds = ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS;
  const stopResult = await execa(
    'docker',
    ['compose', 'stop', '-t', String(drainTimeoutSeconds), 'enclave-mcp-server'],
    {
      cwd: config.workDir,
      env: getLocalDockerEnv(),
      reject: false,
      timeout: (drainTimeoutSeconds + 15) * 1_000,
    },
  );
  if (stopResult.exitCode !== 0) {
    throw new Error('Failed to drain the enclave MCP server before audit preservation');
  }
  const inspectResult = await execa(
    'docker',
    ['inspect', '--format={{.State.ExitCode}}', ENCLAVE_MCP_SERVER_CONTAINER_NAME],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (inspectResult.exitCode !== 0 || inspectResult.stdout.trim() !== '0') {
    throw new Error('Enclave MCP server did not complete graceful cleanup');
  }
  await execa(
    'docker',
    ['network', 'disconnect', '-f', ENCLAVE_MCP_CONTROL_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
}

export const enclaveGatewayTestHelpers = {
  agentTool,
  canonicalJson,
  canonicalToolSet,
  expectedTools,
  inspectGateway,
  proveGatewayReadiness,
  remainingRequestBudget,
  scriptTool,
};
