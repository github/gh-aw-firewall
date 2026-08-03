'use strict';

const fs = require('fs');
const http = require('http');
const { createAuditLog } = require('./audit');
const { createBroker } = require('./broker');
const { loadConfig, loadSeedMap } = require('./config');
const { buildRequestFromFrame, readBoundedBody } = require('./framing');
const { CANONICAL_ERROR_JSON } = require('./protocol');
const { createEnclaveRunner } = require('./enclave-runner');

/**
 * Bounded-agent broker server.
 *
 * The broker itself has `network_mode: none`: it is not on `awf-net`, not on
 * `awf-ext`, and not on the dedicated bounded-agent enclave network. Its whole
 * agent-facing surface is one Unix domain socket shared through a tightly
 * scoped bind mount. It receives the Docker socket only because it launches
 * enclave containers.
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
 * `{"status":"ok","result":<value>}` or `{"status":"error"}` — status code and
 * headers are identical either way, and every failure class collapses to the
 * same error body. For any invocation that reached workspace creation, the
 * response is additionally held until a fixed timing-bucket boundary.
 */

const RESULT_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
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

function processRequest(req, res, broker, audit, isAccepting = () => true) {
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

      const framed = buildRequestFromFrame(req.headers, req.rawHeaders, body.task);
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
    (req, res, isAccepting) => processRequest(req, res, broker, audit, isAccepting),
    audit,
  );
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

async function main() {
  const config = loadConfig();
  const audit = createAuditLog(config.auditDir);
  const { runId, seeds } = loadSeedMap(config.seedMapPath);
  const runner = createEnclaveRunner(config);

  // Fail closed before accepting requests and deterministically reconcile
  // containers left by a prior broker process for this exact run. Enclaves
  // never pull and never fall back.
  await runner.assertAvailable();
  await runner.reconcileRun(runId);

  const broker = createBroker({ config, seedMap: seeds, runId, audit, runner });
  const server = createServer({ broker, audit });

  await listenOnSocket(server, config, audit);

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
    maxInvocations: config.maxInvocations,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    broker.close();
    server.freezeAdmissions();
    server.close();
    const forcedExit = setTimeout(() => process.exit(1), 5000);
    forcedExit.unref();
    try {
      await Promise.race([
        Promise.all([server.drainAdmissions(), broker.drain()]),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
      // Interrupted invocations leave no enclave behind: reconcile again.
      await runner.reconcileRun(runId);
      process.exit(0);
    } catch (error) {
      audit.lifecycle('shutdown-cleanup-failed', error.message);
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
  listenOnSocket,
  MAX_HEADER_BYTES,
  MAX_CONNECTIONS,
};
