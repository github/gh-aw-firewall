'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { createProtectedAuditLog } = require('../../bounded-execution/protected-audit');
const { createEnclaveInformationBudgetLedger } = require('../../bounded-execution/sensitivity-ledger');
const { createExecutorHandler } = require('../script-executor/executor-handler');
const { createScriptRunner } = require('../script-executor/script-runner');
const { createRuntimeTelemetry } = require('../script-executor/runtime-telemetry');
const {
  isAgentExecutorEnabled,
  isScriptExecutorEnabled,
  loadAgentConfig,
  loadConfig,
  loadSeedMap,
  loadServerConfig,
} = require('./config');
const {
  ENCLAVE_EXIT_CATEGORIES,
  agentWorkspaceAdapter,
  createAgentRequestValidator,
  createAgentRunner,
} = require('./agent-executor');
const { AGENT_TOOL_NAME, TOOL_NAME, dispatchJsonRpc, parseJsonRpcBody } = require('./mcp-protocol');

const MAX_HTTP_BODY_BYTES = 420 * 1024;
const RESPONSE_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

function jsonResponse(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { ...RESPONSE_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function safeCapabilityEquals(header, capability) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(capability, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        req.resume();
        finish(undefined);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(undefined));
  });
}

function createSingleToolAdmission() {
  let active = false;
  return () => {
    if (active) return undefined;
    active = true;
    return () => {
      active = false;
    };
  };
}

function createMcpServer(deps) {
  const dispatchDeps = {
    ...deps,
    tryAcquireToolCall: createSingleToolAdmission(),
  };
  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, async (req, res) => {
    const authorizationHeaders = req.rawHeaders.filter(
      (_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization',
    );
    if (authorizationHeaders.length !== 1
        || !safeCapabilityEquals(req.headers.authorization, deps.capability)) {
      req.resume();
      jsonResponse(res, 401, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Unauthorized' },
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      req.resume();
      jsonResponse(res, 404, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }

    const body = await readBody(req);
    const message = body && parseJsonRpcBody(body);
    if (!message) {
      jsonResponse(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    let response;
    try {
      response = await dispatchJsonRpc(message, dispatchDeps);
    } catch {
      jsonResponse(res, 200, {
        jsonrpc: '2.0',
        id: Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null,
        error: { code: -32603, message: 'Internal error' },
      });
      return;
    }
    if (response === undefined) {
      res.writeHead(202, { 'cache-control': 'no-store', 'content-length': '0' });
      res.end();
      return;
    }
    jsonResponse(res, 200, response);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;
  return server;
}

function listenOnPrivateNetwork(server, config) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, config.listenHost, resolve);
  });
}

async function main() {
  const serverConfig = loadServerConfig();
  fs.rmSync(serverConfig.readyPath, { force: true });
  const audit = createProtectedAuditLog(serverConfig.auditDir, 'enclave.jsonl');
  const telemetry = createRuntimeTelemetry(serverConfig.auditDir);
  const { runId, seeds } = loadSeedMap(serverConfig.seedMapPath);

  const scriptEnabled = isScriptExecutorEnabled();
  const agentEnabled = isAgentExecutorEnabled();
  if (!scriptEnabled && !agentEnabled) {
    throw new Error('No enclave executor is enabled');
  }

  // One ledger for the whole run. Script and agent invocations debit the same
  // live per-repository balance, so switching executor kinds can never reset or
  // fork a repository's disclosure budget.
  const ledger = createEnclaveInformationBudgetLedger(seeds);
  // One serialization lane for the whole run: at most one enclave — script or
  // agent — holds private repository content at a time.
  const lane = { tail: Promise.resolve() };
  const handlers = {};
  const runners = [];
  const executors = [];
  let maxScriptBytes;
  let maxPromptBytes;

  if (scriptEnabled) {
    const config = loadConfig();
    const runner = createScriptRunner(config);
    await runner.assertAvailable();
    await runner.reconcileRun(runId);
    runners.push({ runner, config });
    maxScriptBytes = config.maxScriptBytes;
    handlers[TOOL_NAME] = createExecutorHandler({
      config,
      seedMap: seeds,
      runId,
      audit,
      runner,
      ledger,
      telemetry,
      lane,
      executorKind: 'script',
      uniformTiming: true,
    });
    executors.push('script');
  }

  if (agentEnabled) {
    const config = loadAgentConfig(serverConfig);
    const runner = createAgentRunner(config);
    await runner.assertAvailable();
    await runner.reconcileRun(runId);
    runners.push({ runner, config });
    maxPromptBytes = config.maxPromptBytes;
    handlers[AGENT_TOOL_NAME] = createExecutorHandler({
      config,
      seedMap: seeds,
      runId,
      audit,
      runner,
      ledger,
      telemetry,
      lane,
      workspace: agentWorkspaceAdapter,
      validateRequest: createAgentRequestValidator(config.maxPromptBytes),
      payloadKey: 'prompt',
      exitCategories: ENCLAVE_EXIT_CATEGORIES,
      executorKind: 'agent',
      uniformTiming: true,
    });
    executors.push('agent');
  }

  const executorBackends = new Set(runners.map(({ config }) => config.executorBackend));
  const startupExecutorBackend = executorBackends.size === 1
    ? runners[0].config.executorBackend
    : 'mixed';
  telemetry.emit({
    primaryBackend: serverConfig.primaryBackend,
    executorBackend: startupExecutorBackend,
    lifecycleClass: 'startup',
    capabilityState: 'supported',
    category: 'ready',
  });

  const server = createMcpServer({
    handlers,
    capability: serverConfig.capability,
    maxScriptBytes,
    maxPromptBytes,
  });
  await listenOnPrivateNetwork(server, serverConfig);
  fs.mkdirSync(serverConfig.controlDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(serverConfig.readyPath, '', { mode: 0o600 });
  audit.lifecycle('listening', { executors });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const handler of Object.values(handlers)) handler.close();
    server.close();
    try {
      await lane.tail;
      for (const { runner } of runners) await runner.reconcileRun(runId);
      telemetry.emit({
        primaryBackend: serverConfig.primaryBackend,
        executorBackend: startupExecutorBackend,
        lifecycleClass: 'cleanup',
        capabilityState: 'supported',
        category: 'success',
      });
      fs.rmSync(serverConfig.readyPath, { force: true });
      process.exit(0);
    } catch (error) {
      audit.lifecycle('shutdown-cleanup-failed', error.message);
      telemetry.emit({
        primaryBackend: serverConfig.primaryBackend,
        executorBackend: startupExecutorBackend,
        lifecycleClass: 'cleanup',
        capabilityState: 'supported',
        category: 'cleanup-failed',
      });
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[awf-enclave] server failed to start: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  MAX_HTTP_BODY_BYTES,
  createMcpServer,
  createSingleToolAdmission,
  listenOnPrivateNetwork,
  safeCapabilityEquals,
};
