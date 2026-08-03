'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { createAuditLog } = require('./audit');
const { createBroker } = require('./broker');
const { loadConfig, loadSeedMap } = require('./config');
const { buildRequestFromFrame, readBoundedBody } = require('./framing');
const { CANONICAL_ERROR_JSON } = require('./protocol');
const { createEnclaveRunner } = require('./enclave-runner');
const { createRuntimeTelemetry } = require('./runtime-telemetry');

/**
 * Bounded-agent broker server.
 *
 * Compose agents (docker/gvisor primary) reach the broker over a Unix domain
 * socket shared through a tightly scoped bind mount; the broker itself has
 * `network_mode: none` in that mode -- not on `awf-net`, not on `awf-ext`, and
 * not on the dedicated bounded-agent enclave network. sbx primary agents use
 * the same protocol over authenticated HTTP only when a disposable capability
 * probe proves that sbx cannot connect through a mounted host socket. In that
 * mode the broker is attached only to a dedicated internal Docker network and
 * published on an ephemeral host-gateway-only port; it is never on the
 * enclave egress network either way.
 *
 * One route exists:
 *   POST /query   the bounded-agent API
 *
 * The agent-visible socket has no `/health` route. The compose healthcheck
 * instead polls for a broker-internal ready file written by `main()` after the
 * socket starts accepting connections, so there is no distinguishable extra
 * response on the agent-observable surface.
 *
 * `/query` always answers `200` with a canonical result body:
 * `{"status":"ok","result":<value>}` or `{"status":"error"}` -- status code and
 * headers are identical either way, and every failure class collapses to the
 * same error body. For any invocation that reached workspace creation, the
 * response is additionally held until a fixed timing-bucket boundary.
 */

const RESULT_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
// Give a nearly-complete invocation a chance to finish broker cleanup before
// force-removing this run's enclaves. Longer invocations are interrupted so
// Compose shutdown remains bounded; host teardown owns private-root removal.
const SHUTDOWN_GRACE_MS = 1_000;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONNECTIONS = 32;
const PROBE_RESPONSE_DELAY_MS = 10;

function sendResult(res, body) {
  res.writeHead(200, { ...RESULT_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function canonicalRawResponse() {
  return [
    'HTTP/1.1 200 OK',
    'content-type: application/json',
    'cache-control: no-store',
    `content-length: ${Buffer.byteLength(CANONICAL_ERROR_JSON)}`,
    'connection: close',
    '',
    CANONICAL_ERROR_JSON,
  ].join('\r\n');
}

function createHardenedServer(listener, audit) {
  let accepting = true;
  let pendingAdmissions = 0;
  const admissionWaiters = [];
  const resolveAdmissionWaiters = () => {
    if (pendingAdmissions !== 0) return;
    while (admissionWaiters.length > 0) {
      admissionWaiters.shift()();
    }
  };

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (!accepting) {
      sendResult(res, CANONICAL_ERROR_JSON);
      req.resume();
      return;
    }

    pendingAdmissions += 1;
    Promise.resolve(listener(req, res, () => accepting))
      .catch((error) => {
        audit.failure('server', 'unhandled-error', error && error.message);
        if (!res.headersSent) sendResult(res, CANONICAL_ERROR_JSON);
      })
      .finally(() => {
        pendingAdmissions -= 1;
        resolveAdmissionWaiters();
      });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 1;

  let activeConnections = 0;
  server.on('connection', (socket) => {
    activeConnections += 1;
    socket.once('close', () => {
      activeConnections -= 1;
    });
    if (activeConnections > MAX_CONNECTIONS) {
      socket.awfRejected = true;
      audit.failure('transport', 'connection-limit');
      socket.pause();
      socket.end(canonicalRawResponse());
    }
  });
  server.on('clientError', (error, socket) => {
    audit.failure('framing', 'header-rejected', error && error.message);
    setTimeout(() => {
      if (socket.writable) socket.end(canonicalRawResponse());
    }, PROBE_RESPONSE_DELAY_MS);
  });
  server.freezeAdmissions = () => {
    accepting = false;
  };
  server.drainAdmissions = () => (
    pendingAdmissions === 0
      ? Promise.resolve()
      : new Promise((resolve) => admissionWaiters.push(resolve))
  );
  return server;
}

function processRequest(
  req,
  res,
  broker,
  audit,
  framedHeaders = req.headers,
  framedRawHeaders = req.rawHeaders,
  isAccepting = () => true,
) {
  if (req.socket.awfRejected) {
    req.resume();
    res.destroy();
    return Promise.resolve();
  }
  if (req.method !== 'POST' || req.url !== '/query') {
    sendResult(res, CANONICAL_ERROR_JSON);
    req.resume();
    return Promise.resolve();
  }

  return readBoundedBody(req)
    .then((body) => {
      if (!isAccepting()) {
        sendResult(res, CANONICAL_ERROR_JSON);
        return;
      }

      if (body.error !== undefined) {
        audit.failure('framing', 'body-rejected', body.error);
        return broker.handle(undefined, (result) => sendResult(res, result));
      }

      const framed = buildRequestFromFrame(framedHeaders, framedRawHeaders, body.task);
      if (framed.error !== undefined) {
        audit.failure('framing', 'frame-rejected', framed.error);
        return broker.handle(undefined, (result) => sendResult(res, result));
      }

      return broker.handle(framed.request, (result) => sendResult(res, result));
    })
    .catch((error) => {
      audit.failure('server', 'unhandled-error', error && error.message);
      if (!res.headersSent) sendResult(res, CANONICAL_ERROR_JSON);
    });
}

function createServer(deps) {
  const { broker, audit } = deps;
  return createHardenedServer(
    (req, res, isAccepting) => processRequest(
      req,
      res,
      broker,
      audit,
      req.headers,
      req.rawHeaders,
      isAccepting,
    ),
    audit,
  );
}

function safeCapabilityEquals(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function stripCapabilityHeader(req) {
  const headers = { ...req.headers };
  delete headers['x-awf-capability'];
  const rawHeaders = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'x-awf-capability') continue;
    rawHeaders.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  return { headers, rawHeaders };
}

/**
 * Authenticated HTTP listener for sbx-primary reachability only. Every
 * request must carry exactly one `x-awf-capability` header matching the
 * broker-generated `query` token; the distinct `probe` token is accepted
 * exactly once (pre-agent reachability proof), then permanently retired for
 * the lifetime of this process. Neither token is ever logged, telemetered, or
 * written to the audit ledger -- only the fixed category strings
 * `'auth-rejected'` / `'sbx-ingress-probe'` are.
 */
function createTcpServer(deps) {
  const { broker, audit, capabilities } = deps;
  let probeAvailable = true;
  return createHardenedServer((req, res, isAccepting) => {
    const capabilityHeaders = req.rawHeaders.filter(
      (_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'x-awf-capability',
    );
    const supplied = req.headers['x-awf-capability'];
    const isQuery = capabilityHeaders.length === 1 && safeCapabilityEquals(supplied, capabilities.query);
    const isProbe = (
      probeAvailable
      && capabilityHeaders.length === 1
      && safeCapabilityEquals(supplied, capabilities.probe)
    );

    if (isProbe) {
      probeAvailable = false;
      audit.lifecycle('sbx-ingress-probe');
      req.resume();
      return new Promise((resolve) => {
        setTimeout(() => {
          sendResult(res, CANONICAL_ERROR_JSON);
          resolve();
        }, PROBE_RESPONSE_DELAY_MS);
      });
    }

    if (!isQuery) {
      audit.failure('transport', 'auth-rejected');
      req.resume();
      sendResult(res, CANONICAL_ERROR_JSON);
      return Promise.resolve();
    }

    const framed = stripCapabilityHeader(req);
    return processRequest(
      req,
      res,
      broker,
      audit,
      framed.headers,
      framed.rawHeaders,
      isAccepting,
    );
  }, audit);
}

function listenOnSocket(server, config, audit) {
  fs.rmSync(config.socketPath, { force: true });
  fs.mkdirSync(config.socketDir, { recursive: true, mode: 0o770 });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socketPath, () => {
      try {
        // The agent runs as the host user; hand it the socket explicitly
        // rather than making the socket world-writable.
        fs.chownSync(config.socketPath, config.socketUid, config.socketGid);
        fs.chmodSync(config.socketPath, 0o660);
      } catch (error) {
        audit.lifecycle('socket-ownership-fallback', error.message);
        fs.chmodSync(config.socketPath, 0o666);
      }

      resolve();
    });
  });
}

function listenOnTcp(server, config) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.tcpPort, '0.0.0.0', resolve);
  });
}

async function main() {
  const config = loadConfig();
  const audit = createAuditLog(config.auditDir);
  const telemetry = createRuntimeTelemetry(config.auditDir);
  const { runId, seeds } = loadSeedMap(config.seedMapPath);
  const runner = createEnclaveRunner(config);

  // Fail closed before accepting requests and deterministically reconcile
  // enclaves left by a prior broker process for this exact run. Enclaves
  // never pull and never fall back.
  await runner.assertAvailable();
  await runner.reconcileRun(runId);
  telemetry.emit({
    primaryBackend: config.primaryBackend,
    boundedAgentBackend: config.backend,
    lifecycleClass: 'startup',
    capabilityState: 'supported',
    category: 'ready',
  });

  const broker = createBroker({ config, seedMap: seeds, runId, audit, runner, telemetry });
  const unixServer = createServer({ broker, audit });
  const servers = [unixServer];

  await listenOnSocket(unixServer, config, audit);
  if (config.tcpPort !== undefined) {
    const tcpServer = createTcpServer({
      broker,
      audit,
      capabilities: config.sbxIngressCapabilities,
    });
    await listenOnTcp(tcpServer, config);
    servers.push(tcpServer);
  }

  // Write the ready file AFTER the socket is accepting connections. The compose
  // healthcheck polls this file in the broker-only control mount.
  fs.mkdirSync(config.controlDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.readyPath, '', { mode: 0o644 });

  // Deliberately records no repository names, task text, model identity, or
  // host paths beyond the fixed socket location.
  audit.lifecycle('listening', {
    repos: seeds.size,
    backend: config.backend,
    profile: config.profile,
    ingress: config.tcpPort === undefined ? 'unix' : 'unix+sbx-http',
    maxInvocations: config.maxInvocations,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    broker.close();
    for (const server of servers) {
      server.freezeAdmissions();
      server.close();
    }
    const forcedExit = setTimeout(() => process.exit(1), 5000);
    forcedExit.unref();
    try {
      await Promise.race([
        Promise.all([
          ...servers.map((server) => server.drainAdmissions()),
          broker.drain(),
        ]),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
      // Interrupted invocations leave no enclave behind: reconcile again.
      await runner.reconcileRun(runId);
      telemetry.emit({
        primaryBackend: config.primaryBackend,
        boundedAgentBackend: config.backend,
        lifecycleClass: 'cleanup',
        capabilityState: 'supported',
        category: 'success',
      });
      process.exit(0);
    } catch (error) {
      audit.lifecycle('shutdown-cleanup-failed', error.message);
      telemetry.emit({
        primaryBackend: config.primaryBackend,
        boundedAgentBackend: config.backend,
        lifecycleClass: 'cleanup',
        capabilityState: 'supported',
        category: 'cleanup-failed',
      });
      process.exit(1);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[bounded-agent] broker failed to start: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  createTcpServer,
  listenOnSocket,
  listenOnTcp,
  MAX_HEADER_BYTES,
  MAX_CONNECTIONS,
};
