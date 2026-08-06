'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { createProtectedAuditLog } = require('../bounded-execution/protected-audit');
const { createEnclaveInformationBudgetLedger } = require('../bounded-execution/sensitivity-ledger');
const { createBroker } = require('../broker/broker');
const { createQueryRunner } = require('../broker/query-runner');
const { createRuntimeTelemetry } = require('../broker/runtime-telemetry');
const { loadConfig, loadSeedMap } = require('./config');
const { dispatchJsonRpc, parseJsonRpcBody } = require('./mcp-protocol');

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

function createMcpServer(deps) {
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

    const response = await dispatchJsonRpc(message, deps);
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

function listenOnSocket(server, config) {
  fs.rmSync(config.socketPath, { force: true });
  fs.mkdirSync(config.socketDir, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => {
      try {
        fs.chownSync(config.socketPath, config.socketUid, config.socketGid);
        fs.chmodSync(config.socketPath, 0o660);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const config = loadConfig();
  fs.rmSync(config.readyPath, { force: true });
  const audit = createProtectedAuditLog(config.auditDir, 'enclave.jsonl');
  const telemetry = createRuntimeTelemetry(config.auditDir);
  const { runId, seeds } = loadSeedMap(config.seedMapPath);
  const runner = createQueryRunner(config);
  await runner.assertAvailable();
  await runner.reconcileRun(runId);
  telemetry.emit({
    primaryBackend: config.primaryBackend,
    queryBackend: config.queryBackend,
    lifecycleClass: 'startup',
    capabilityState: 'supported',
    category: 'ready',
  });

  const ledger = createEnclaveInformationBudgetLedger(seeds);
  const broker = createBroker({
    config,
    seedMap: seeds,
    runId,
    audit,
    runner,
    ledger,
    telemetry,
    executorKind: 'script',
    uniformTiming: true,
  });
  const server = createMcpServer({
    broker,
    capability: config.capability,
    maxScriptBytes: config.maxScriptBytes,
  });
  await listenOnSocket(server, config);
  fs.mkdirSync(config.controlDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.readyPath, '', { mode: 0o600 });
  audit.lifecycle('listening', { executor: 'script' });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    broker.close();
    server.close();
    try {
      await broker.drain();
      await runner.reconcileRun(runId);
      telemetry.emit({
        primaryBackend: config.primaryBackend,
        queryBackend: config.queryBackend,
        lifecycleClass: 'cleanup',
        capabilityState: 'supported',
        category: 'success',
      });
      fs.rmSync(config.readyPath, { force: true });
      process.exit(0);
    } catch (error) {
      audit.lifecycle('shutdown-cleanup-failed', error.message);
      telemetry.emit({
        primaryBackend: config.primaryBackend,
        queryBackend: config.queryBackend,
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
  listenOnSocket,
  safeCapabilityEquals,
};
