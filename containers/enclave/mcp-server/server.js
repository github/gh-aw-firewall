'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { createProtectedAuditLog } = require('../../bounded-execution/protected-audit');
const { createEnclaveInformationBudgetLedger } = require('../../bounded-execution/sensitivity-ledger');
const { createExecutorHandler } = require('../script-executor/executor-handler');
const { createScriptRunner } = require('../script-executor/script-runner');
const { createRuntimeTelemetry } = require('../script-executor/runtime-telemetry');
const { createRealClock } = require('../../bounded-execution/fixed-timing');
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
const { createDynamicDelegationClient } = require('./delegation-channel');
const { createToolCallBudget } = require('./tool-call-budget');
const { createHostExecutorRunner } = require('./host-executor-runner');
const { createStartupReporter, runStartupStage, startupDiagnostic } = require('./startup-diagnostics');
const { probeStartupEnvironment } = require('./environment-probes');

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

function createMcpServer(deps) {
  const activeRequests = new Map();
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
  const scriptConfigured = isScriptExecutorEnabled();
  const agentConfigured = isAgentExecutorEnabled();
  const configuredBackends = new Set([
    scriptConfigured ? process.env.AWF_ENCLAVE_BACKEND : undefined,
    agentConfigured ? process.env.AWF_ENCLAVE_AGENT_BACKEND : undefined,
  ].filter(Boolean));
  startupReporter.configure({
    primaryBackend: process.env.AWF_ENCLAVE_PRIMARY_BACKEND,
    executorBackend: configuredBackends.size > 1 ? 'mixed' : [...configuredBackends][0],
    executorKind: scriptConfigured && agentConfigured ? 'both'
      : scriptConfigured ? 'script' : agentConfigured ? 'agent' : 'none',
  });
  startupReporter.plan([
    'server-config', 'audit', 'seed-map', 'executors', 'executor-state',
    ...(scriptConfigured ? [
      'script-config', 'script-selection', 'script-available', 'script-reconcile', 'script-handler',
    ] : []),
    ...(agentConfigured ? [
      'agent-config', 'agent-selection', 'agent-available', 'agent-reconcile', 'agent-handler',
    ] : []),
    'backend-consistency', 'tool-budget', 'listener-binding', 'ready-file',
  ]);

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
  const runners = [];
  const executors = [];
  let maxScriptBytes;
  let maxPromptBytes;

  if (scriptEnabled) {
    const config = await runStartupStage(
      startupReporter, 'script-config', 'script-config-invalid', () => loadConfig(),
      { executorKind: 'script' },
    );
    const runner = await runStartupStage(
      startupReporter, 'script-selection', 'script-runner-initialization-failed', () =>
        config.executorBackend === 'cloud-hypervisor'
          ? createHostExecutorRunner(config, { nowMs: clock.nowMs })
          : createScriptRunner(config, { nowMs: clock.nowMs }),
      { executorKind: 'script' },
    );
    startupReporter.configure({
      primaryBackend: serverConfig.primaryBackend,
      executorBackend: agentEnabled
        && process.env.AWF_ENCLAVE_AGENT_BACKEND !== config.executorBackend
        ? 'mixed' : config.executorBackend,
      executorKind: agentEnabled ? 'both' : 'script',
    });
    await runStartupStage(startupReporter, 'script-available', 'script-availability-failed',
      () => runner.assertAvailable(), { executorKind: 'script' });
    await runStartupStage(startupReporter, 'script-reconcile', 'script-reconciliation-failed',
      () => runner.reconcileRun(runId), { executorKind: 'script' });
    runners.push({ runner, config });
    maxScriptBytes = config.maxScriptBytes;
    handlers[TOOL_NAME] = await runStartupStage(
      startupReporter, 'script-handler', 'script-handler-construction-failed', () =>
        createExecutorHandler({
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
          clock,
        }),
      { executorKind: 'script' },
    );
    executors.push('script');
  }

  if (agentEnabled) {
    const config = await runStartupStage(
      startupReporter, 'agent-config', 'agent-config-invalid', () => loadAgentConfig(serverConfig),
      { executorKind: 'agent' },
    );
    const runner = await runStartupStage(
      startupReporter, 'agent-selection', 'agent-runner-initialization-failed', () =>
        config.executorBackend === 'cloud-hypervisor'
          ? createHostExecutorRunner(config, { nowMs: clock.nowMs })
          : createAgentRunner(config, { nowMs: clock.nowMs }),
      { executorKind: 'agent' },
    );
    const selectedBackends = new Set([
      ...runners.map(({ config: current }) => current.executorBackend), config.executorBackend,
    ]);
    startupReporter.configure({
      primaryBackend: serverConfig.primaryBackend,
      executorBackend: selectedBackends.size === 1 ? config.executorBackend : 'mixed',
      executorKind: scriptEnabled ? 'both' : 'agent',
    });
    await runStartupStage(startupReporter, 'agent-available', 'agent-availability-failed',
      () => runner.assertAvailable(), { executorKind: 'agent' });
    await runStartupStage(startupReporter, 'agent-reconcile', 'agent-reconciliation-failed',
      () => runner.reconcileRun(runId), { executorKind: 'agent' });
    runners.push({ runner, config });
    maxPromptBytes = config.maxPromptBytes;
    handlers[AGENT_TOOL_NAME] = await runStartupStage(
      startupReporter, 'agent-handler', 'agent-handler-construction-failed', () =>
        createExecutorHandler({
          config,
          seedMap: seeds,
          runId,
          audit,
          runner,
          ledger,
          telemetry,
          lane,
          workspace: agentWorkspaceAdapter,
          validateRequest: createAgentRequestValidator(config.maxPromptBytes, {
            githubEnabled: config.githubEnabled,
            dynamicEnabled: config.dynamicEnabled,
          }),
          payloadKey: 'prompt',
          exitCategories: ENCLAVE_EXIT_CATEGORIES,
          executorKind: 'agent',
          uniformTiming: true,
          clock,
          // Dynamic entries route every selector through AWF's canonical
          // admission before any repository content is exposed. `enclave_run_script`
          // is never registered for a dynamic entry, so it is neither advertised
          // nor dispatchable.
          ...(config.dynamicEnabled
            ? { admission: createDynamicDelegationClient(config) }
            : {}),
        }),
      { executorKind: 'agent' },
    );
    executors.push('agent');
  }

  const executorBackends = new Set(runners.map(({ config }) => config.executorBackend));
  const startupExecutorBackend = executorBackends.size === 1
    ? runners[0].config.executorBackend
    : 'mixed';
  startupReporter.configure({
    primaryBackend: serverConfig.primaryBackend,
    executorBackend: startupExecutorBackend,
    executorKind: scriptEnabled && agentEnabled ? 'both' : scriptEnabled ? 'script' : 'agent',
  });
  await runStartupStage(startupReporter, 'backend-consistency', 'backend-consistency-failed', () => {
    if (executorBackends.size === 0 || !runners.length) throw new Error('No selected executor backend');
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
  createSingleToolAdmission,
  listenOnPrivateNetwork,
  safeCapabilityEquals,
};
