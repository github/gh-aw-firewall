'use strict';

const {
  MAX_SCRIPT_BYTES,
  MAX_SCHEMA_BYTES,
  strictParseJson,
} = require('../../bounded-execution/finite-disclosure');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const TOOL_NAME = 'enclave_run_script';
const AGENT_TOOL_NAME = 'enclave_run_agent';
const JSONRPC_ERROR = Object.freeze({ status: 'error' });

function canonicalToolError() {
  return {
    content: [{ type: 'text', text: '{"status":"error"}' }],
    structuredContent: JSONRPC_ERROR,
  };
}

const FINITE_SCHEMA_INPUT = Object.freeze({
  type: 'object',
  description: 'An AWF finite-disclosure schema (const, boolean, enum, integer, object, tuple, array, or union).',
});

const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: 'Run a bounded script against one configured private repository and return one finite value.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      privateRepo: Object.freeze({ type: 'string', description: 'Bare configured owner/repository selector.' }),
      schema: FINITE_SCHEMA_INPUT,
      script: Object.freeze({ type: 'string', description: 'Bounded UTF-8 Python source.' }),
    }),
    required: Object.freeze(['privateRepo', 'schema', 'script']),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      status: Object.freeze({ enum: Object.freeze(['ok', 'error']) }),
      result: Object.freeze({}),
    }),
    required: Object.freeze(['status']),
    additionalProperties: false,
  }),
});

/**
 * Static prompt-driven agent tool.
 *
 * The caller supplies exactly a configured repository selector, a finite
 * response schema, and the prompt text. Everything else about the enclave —
 * runtime, engine, model, provider, profile, endpoints, mounts, network,
 * tools, credentials, resource bounds, system prompt, and message construction
 * — is trusted AWF configuration and an AWF-authored fixed model loop. The
 * schema deliberately forbids additional properties so an unknown control is
 * rejected rather than ignored.
 */
const AGENT_TOOL = Object.freeze({
  name: AGENT_TOOL_NAME,
  description:
    'Run a bounded, single-use agent enclave against one configured private repository and return '
    + 'one finite value.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      privateRepo: Object.freeze({ type: 'string', description: 'Bare configured owner/repository selector.' }),
      schema: FINITE_SCHEMA_INPUT,
      prompt: Object.freeze({ type: 'string', description: 'Bounded UTF-8 task prompt.' }),
    }),
    required: Object.freeze(['privateRepo', 'schema', 'prompt']),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      status: Object.freeze({ enum: Object.freeze(['ok', 'error']) }),
      result: Object.freeze({}),
    }),
    required: Object.freeze(['status']),
    additionalProperties: false,
  }),
});

/** Every tool the server can publish, keyed by its wire name. */
const TOOLS_BY_NAME = Object.freeze({
  [TOOL_NAME]: TOOL,
  [AGENT_TOOL_NAME]: AGENT_TOOL,
});

/** Byte bound applied to a tool's single free-form payload argument. */
const TOOL_PAYLOAD_KEYS = Object.freeze({
  [TOOL_NAME]: 'script',
  [AGENT_TOOL_NAME]: 'prompt',
});

const TOOLS_LIST_RESULT = Object.freeze({ tools: Object.freeze([TOOL]) });

/**
 * Resolves the executor handlers this server exposes.
 */
function resolveHandlers(deps) {
  return deps.handlers || {};
}

/**
 * Publishes exactly the tools whose executor is enabled for this run.
 *
 * The listing carries no repository, budget, sensitivity, model, engine,
 * profile, endpoint, or runtime information: it is a fixed, static document
 * per tool.
 */
function toolsListResult(deps) {
  const handlers = resolveHandlers(deps);
  const tools = Object.keys(TOOLS_BY_NAME)
    .filter((name) => handlers[name] !== undefined)
    .map((name) => TOOLS_BY_NAME[name]);
  return { tools };
}

/** Per-tool byte bound for the single free-form payload argument. */
function payloadLimitFor(name, deps) {
  return name === AGENT_TOOL_NAME ? deps.maxPromptBytes : deps.maxScriptBytes;
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function hasOnlyKeys(value, allowed) {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key))
  );
}

function handlerCall(handler, request) {
  return new Promise((resolve) => {
    handler.handle(request, (canonicalJson) => {
      const parsed = strictParseJson(canonicalJson);
      if (!parsed || !parsed.value || parsed.value.status !== 'ok') {
        resolve(canonicalToolError());
        return;
      }
      resolve({
        content: [{ type: 'text', text: canonicalJson }],
        structuredContent: {
          status: 'ok',
          result: parsed.value.result,
        },
      });
    });
  });
}

async function dispatchJsonRpc(message, deps) {
  if (!hasOnlyKeys(message, new Set(['jsonrpc', 'id', 'method', 'params']))
      || message.jsonrpc !== '2.0'
      || typeof message.method !== 'string'
      || (!Object.prototype.hasOwnProperty.call(message, 'id') && message.method !== 'notifications/initialized')) {
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }

  if (message.method === 'notifications/initialized') {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      return rpcError(message.id, -32600, 'Invalid Request');
    }
    return undefined;
  }

  if (message.method === 'initialize') {
    return rpcResult(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'awf-enclave', version: '1.0.0' },
    });
  }

  if (message.method === 'tools/list') {
    if (message.params !== undefined && !hasOnlyKeys(message.params, new Set())) {
      return rpcError(message.id, -32602, 'Invalid params');
    }
    return rpcResult(message.id, toolsListResult(deps));
  }

  if (message.method === 'tools/call') {
    const handlers = resolveHandlers(deps);
    if (!hasOnlyKeys(message.params, new Set(['name', 'arguments']))
        || typeof message.params.name !== 'string'
        || !Object.prototype.hasOwnProperty.call(handlers, message.params.name)
        || !Object.prototype.hasOwnProperty.call(message.params, 'arguments')) {
      return rpcError(message.id, -32602, 'Invalid params');
    }
    const name = message.params.name;
    const args = message.params.arguments;
    if (!Object.prototype.hasOwnProperty.call(TOOL_PAYLOAD_KEYS, name)) {
      return rpcError(message.id, -32602, 'Invalid params');
    }
    const payloadKey = TOOL_PAYLOAD_KEYS[name];
    const limit = payloadLimitFor(name, deps);
    // An oversized payload is dropped before the handler buffers it; the
    // caller still observes only its canonical error.
    const tooLarge = (
      args
      && typeof args[payloadKey] === 'string'
      && typeof limit === 'number'
      && Buffer.byteLength(args[payloadKey], 'utf8') > limit
    );
    const request = tooLarge ? undefined : args;
    let release;
    if (typeof deps.tryAcquireToolCall === 'function') {
      release = deps.tryAcquireToolCall();
      if (typeof release !== 'function') {
        return rpcResult(message.id, canonicalToolError());
      }
    }
    try {
      return rpcResult(message.id, await handlerCall(handlers[name], request));
    } finally {
      if (release) release();
    }
  }

  return rpcError(message.id, -32601, 'Method not found');
}

function parseJsonRpcBody(buffer) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) return undefined;
  if (Buffer.byteLength(text, 'utf8') > ((MAX_SCRIPT_BYTES + MAX_SCHEMA_BYTES) * 6) + 4096) return undefined;
  const parsed = strictParseJson(text);
  return parsed && parsed.value;
}

module.exports = {
  AGENT_TOOL,
  AGENT_TOOL_NAME,
  MCP_PROTOCOL_VERSION,
  TOOL,
  TOOLS_BY_NAME,
  TOOL_NAME,
  TOOL_PAYLOAD_KEYS,
  TOOLS_LIST_RESULT,
  dispatchJsonRpc,
  parseJsonRpcBody,
  toolsListResult,
};
