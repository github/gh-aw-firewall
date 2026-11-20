'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { createProtectedAuditLog } = require('../../bounded-execution/protected-audit');
const { createEnclaveInformationBudgetLedger } = require('../../bounded-execution/sensitivity-ledger');
const { createRuntimeTelemetry } = require('../script-executor/runtime-telemetry');
const { createRealClock } = require('../../bounded-execution/fixed-timing');
const {
  loadSeedMap,
  loadServerConfig,
} = require('./config');
const { dispatchJsonRpc, parseJsonRpcBody } = require('./mcp-protocol');
const { createToolCallBudget } = require('./tool-call-budget');
const { createStartupReporter, runStartupStage, startupDiagnostic } = require('./startup-diagnostics');
const { probeStartupEnvironment } = require('./environment-probes');
const { createStartupPlan, getExecutorBackend } = require('./startup-plan');
const { configureExecutor } = require('./startup-executors');

let startupReporter;

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

function createBoundedToolAdmissionAudit(diagnosticAudit, limit = 4096) {
  if (!diagnosticAudit) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Tool admission diagnostic limit must be a positive integer');
  }
  let records = 0;
  return {
    lifecycle(event, record) {
      if (event !== 'tool-admission') {
        diagnosticAudit.lifecycle(event, record);
        return;
      }
      if (records > limit) return;
      records += 1;
      diagnosticAudit.lifecycle(event, records > limit
        ? { phase: 'diagnostics', status: 'limit-reached' }
        : record);
    },
  };
}

function createMcpServer(deps) {
  const activeRequests = new Map();
  const dispatchDeps = {
    ...deps,
    diagnosticAudit: createBoundedToolAdmissionAudit(deps.diagnosticAudit),
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

    if (message.jsonrpc === '2.0' && message.method === 'notifications/cancelled'
        && !Object.prototype.hasOwnProperty.call(message, 'id')
        && Object.keys(message).every((key) => ['jsonrpc', 'method', 'params'].includes(key))
        && message.params && typeof message.params === 'object'
        && !Array.isArray(message.params)
        && Object.keys(message.params).every((key) => ['requestId', 'reason'].includes(key))
        && ['string', 'number'].includes(typeof message.params.requestId)
        && (message.params.reason === undefined || typeof message.params.reason === 'string')) {
      activeRequests.get(message.params.requestId)?.abort();
      res.writeHead(202, { 'cache-control': 'no-store', 'content-length': '0' });
      res.end();
      return;
    }

    let response;
    try {
      const cancellation = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) cancellation.abort();
      };
      res.once('close', disconnect);
      const track = message.method === 'tools/call' && !activeRequests.has(message.id);
      if (track) activeRequests.set(message.id, cancellation);
      try {
        response = await dispatchJsonRpc(message, { ...dispatchDeps, signal: cancellation.signal });
      } finally {
        res.removeListener('close', disconnect);
        if (track) activeRequests.delete(message.id);
      }
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
  startupReporter = createStartupReporter();
  const {
    scriptEnabled: scriptConfigured, agentEnabled: agentConfigured, context, stages,
  } = createStartupPlan();
  startupReporter.configure(context);
  startupReporter.plan(stages);

  startupReporter.start('environment-probes', 'environment-probe-failed');
  const probes = await probeStartupEnvironment();
  startupReporter.passed('environment-probes', probes);

  const serverConfig = await runStartupStage(
    startupReporter, 'server-config', 'server-config-invalid', () => loadServerConfig(),
  );
  startupReporter.configure({ primaryBackend: serverConfig.primaryBackend });
  const { audit, telemetry, clock } = await runStartupStage(
    startupReporter, 'audit', 'audit-initialization-failed', () => {
      fs.rmSync(serverConfig.readyPath, { force: true });
      return {
        audit: createProtectedAuditLog(serverConfig.auditDir, 'enclave.jsonl'),
        telemetry: createRuntimeTelemetry(serverConfig.auditDir),
        clock: createRealClock(),
      };
    },
  );
  // A dynamic-only run stages no seed catalog at all: no clone, no seed map,
  // no /awf/seed mount, and no job token anywhere in the topology.
  const { runId, seeds } = await runStartupStage(
    startupReporter, 'seed-map', 'seed-catalog-invalid', () => {
      const seedData = serverConfig.seedMapEnabled
        ? loadSeedMap(serverConfig.seedMapPath)
        : { runId: serverConfig.runId, seeds: new Map() };
      if (!seedData.runId) throw new Error('Run identity is unavailable');
      return seedData;
    },
  );

  const { scriptEnabled, agentEnabled } = await runStartupStage(
    startupReporter, 'executors', 'executor-selection-invalid', () => {
      if (!scriptConfigured && !agentConfigured) throw new Error('No enclave executor is enabled');
      return { scriptEnabled: scriptConfigured, agentEnabled: agentConfigured };
    },
  );
  // One ledger for the whole run. Script and agent invocations debit the same
  // live per-repository balance, so switching executor kinds can never reset or
  // fork a repository's disclosure budget.
  const { ledger, lane } = await runStartupStage(
    startupReporter, 'executor-state', 'executor-state-initialization-failed', () => ({
      ledger: createEnclaveInformationBudgetLedger(seeds),
      // One serialization lane for the whole run: at most one enclave — script or
      // agent — holds private repository content at a time.
      lane: { tail: Promise.resolve() },
    }),
  );
  const handlers = {};
  const hostExecutorAudit = createProtectedAuditLog(serverConfig.auditDir, 'enclave-host-executor.jsonl');
  const runners = [];
  const executors = [];
  const executorContext = {
    startupReporter, serverConfig, scriptEnabled, agentEnabled,
    runId, seeds, audit, hostExecutorAudit, clock, ledger, telemetry, lane,
    handlers, runners, executors,
  };
  let maxScriptBytes;
  let maxPromptBytes;

  if (scriptEnabled) {
    const config = await configureExecutor({ ...executorContext, kind: 'script' });
    maxScriptBytes = config.maxScriptBytes;
  }

  if (agentEnabled) {
    const config = await configureExecutor({ ...executorContext, kind: 'agent' });
    maxPromptBytes = config.maxPromptBytes;
  }

  const startupExecutorBackend = getExecutorBackend(runners);
  startupReporter.configure({
    primaryBackend: serverConfig.primaryBackend,
    executorBackend: startupExecutorBackend,
    executorKind: scriptEnabled && agentEnabled ? 'both' : scriptEnabled ? 'script' : 'agent',
  });
  await runStartupStage(startupReporter, 'backend-consistency', 'backend-consistency-failed', () => {
    if (!runners.length) throw new Error('No selected executor backend');
    if (runners.some(({ config }) => config.primaryBackend !== serverConfig.primaryBackend)) {
      throw new Error('Executor primary backend differs from server configuration');
    }
    if (executors.length !== runners.length) throw new Error('Executor and handler initialization differ');
  });

  const toolCallBudget = await runStartupStage(
    startupReporter, 'tool-budget', 'tool-budget-initialization-failed', () => {
      const budget = createToolCallBudget({
        maxToolCalls: serverConfig.maxToolCalls,
        runId,
        statePath: serverConfig.toolCallBudgetPath,
      });
      if (budget) audit.lifecycle('tool-call-cap', `max=${budget.limit} used=${budget.used()}`);
      return budget;
    },
  );

  const server = await runStartupStage(
    startupReporter, 'listener-binding', 'listener-binding-failed', async () => {
      const mcpServer = createMcpServer({
        handlers,
        capability: serverConfig.capability,
        maxScriptBytes,
        maxPromptBytes,
        toolCallBudget,
        diagnosticAudit: hostExecutorAudit,
      });
      await listenOnPrivateNetwork(mcpServer, serverConfig);
      return mcpServer;
    },
  );
  await runStartupStage(startupReporter, 'ready-file', 'ready-file-publication-failed', () => {
    fs.mkdirSync(serverConfig.controlDir, { recursive: true, mode: 0o700 });
    audit.lifecycle('listening', { executors });
    telemetry.emit({
      primaryBackend: serverConfig.primaryBackend,
      executorBackend: startupExecutorBackend,
      lifecycleClass: 'startup',
      capabilityState: 'supported',
      category: 'ready',
    });
    fs.writeFileSync(serverConfig.readyPath, '', { mode: 0o600 });
  });

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
    const context = startupReporter?.failureContext() || {};
    process.stderr.write(`${JSON.stringify(startupDiagnostic(error, startupReporter?.currentStage, context))}\n`);
    process.exit(1);
  });
}

module.exports = {
  MAX_HTTP_BODY_BYTES,
  createMcpServer,
  createBoundedToolAdmissionAudit,
  createSingleToolAdmission,
  listenOnPrivateNetwork,
  main,
  safeCapabilityEquals,
};
