import { TIMING_BUCKETS_MS } from '../bounded-execution';
import type { WrapperConfig } from '../types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { toolCallCapAdvisory } = require('../../containers/enclave/mcp-server/tool-call-budget.js') as {
  toolCallCapAdvisory: (maxToolCalls: number) => string;
};

export const ENCLAVE_MCP_CAPABILITY_ENV = 'AWF_ENCLAVE_MCP_CAPABILITY';
export const ENCLAVE_MCP_GATEWAY_CONTAINER_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_CONTAINER';
export const ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT';
export const ENCLAVE_MCP_GATEWAY_IDENTITY_ENV = 'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY';
export const ENCLAVE_MCP_READINESS_TIMEOUT_ENV = 'AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS';
export const ENCLAVE_MCP_GATEWAY_RUN_LABEL = 'com.github.gh-aw.mcpg.run';
export const ENCLAVE_MCP_SERVER_NAME = 'awf-enclave';
export const ENCLAVE_MCP_UPSTREAM_URL = 'http://awf-enclave-mcp:8080/mcp';
const MCP_GATEWAY_API_KEY_ENV = 'MCP_GATEWAY_API_KEY';

const DEFAULT_GATEWAY_CONTAINER = 'awmg-mcpg';
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 5_000;
export const RETRY_DELAY_MS = 500;
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const ENCLAVE_MCP_TRANSPORT_GRACE_SECONDS = 60;
export const ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS =
  Math.max(...TIMING_BUCKETS_MS) / 1_000 + ENCLAVE_MCP_TRANSPORT_GRACE_SECONDS;

export interface EnclaveGatewayContract {
  capability: string;
  containerName: string;
  endpoint: URL;
  gatewayApiKey: string;
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

const finiteSchemaInput = {
  type: 'object',
  description:
    'An AWF structured response schema (const, boolean, string for trusted repositories, enum, integer, object, tuple, array, or union).',
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

export const scriptTool = {
  name: 'enclave_run_script',
  description: 'Run a bounded script against one configured repository and return one structured value.',
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

export const agentTool = {
  name: 'enclave_run_agent',
  description:
    'Run a bounded, single-use agent enclave against one configured repository and return one structured value.',
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

export function expectedTools(config: WrapperConfig): ReadonlyArray<Record<string, unknown>> {
  const tools: Record<string, unknown>[] = [];
  if (config.enclaves?.executors.script.enabled) tools.push(scriptTool);
  if (config.enclaves?.executors.agent.enabled) tools.push(agentTool);
  const limit = config.maxNumToolCalls;
  return limit === undefined ? tools : tools.map((tool) => ({
    ...tool,
    description: `${String(tool.description)} ${toolCallCapAdvisory(limit)}`,
  }));
}

export function expectedRoutedTools(
  tools: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: `[${ENCLAVE_MCP_SERVER_NAME}] ${String(tool.description)}`,
    inputSchema: tool.inputSchema,
  }));
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
  const gatewayApiKey = env[MCP_GATEWAY_API_KEY_ENV] ?? '';
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
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(gatewayApiKey)) {
    throw new Error(`${MCP_GATEWAY_API_KEY_ENV} is missing or invalid`);
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
    gatewayApiKey,
    identity,
    expectedTools: expectedTools(config),
    readinessTimeoutMs,
  };
}
