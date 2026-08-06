'use strict';

const {
  MAX_SCRIPT_BYTES,
  MAX_SCHEMA_BYTES,
  strictParseJson,
} = require('../bounded-execution/finite-disclosure');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const TOOL_NAME = 'enclave_run_script';
const JSONRPC_ERROR = Object.freeze({ status: 'error' });

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

const TOOLS_LIST_RESULT = Object.freeze({ tools: Object.freeze([TOOL]) });

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

function brokerCall(broker, request) {
  return new Promise((resolve) => {
    broker.handle(request, (canonicalJson) => {
      const parsed = strictParseJson(canonicalJson);
      if (!parsed || !parsed.value || parsed.value.status !== 'ok') {
        resolve({
          content: [{ type: 'text', text: '{"status":"error"}' }],
          structuredContent: JSONRPC_ERROR,
        });
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
    return rpcResult(message.id, TOOLS_LIST_RESULT);
  }

  if (message.method === 'tools/call') {
    if (!hasOnlyKeys(message.params, new Set(['name', 'arguments']))
        || message.params.name !== TOOL_NAME
        || !Object.prototype.hasOwnProperty.call(message.params, 'arguments')) {
      return rpcError(message.id, -32602, 'Invalid params');
    }
    const args = message.params.arguments;
    const tooLarge = (
      args
      && typeof args.script === 'string'
      && Buffer.byteLength(args.script, 'utf8') > deps.maxScriptBytes
    );
    const request = tooLarge ? undefined : args;
    return rpcResult(message.id, await brokerCall(deps.broker, request));
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
  MCP_PROTOCOL_VERSION,
  TOOL,
  TOOL_NAME,
  TOOLS_LIST_RESULT,
  dispatchJsonRpc,
  parseJsonRpcBody,
};
