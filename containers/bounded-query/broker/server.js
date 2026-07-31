'use strict';

const fs = require('fs');
const http = require('http');
const { createAuditLog } = require('./audit');
const { createBroker } = require('./broker');
const { loadConfig, loadSeedMap } = require('./config');
const { buildRequestFromFrame, readBoundedBody } = require('./framing');
const { CANONICAL_ERROR_JSON } = require('./protocol');
const { createQueryRunner } = require('./query-runner');

/**
 * Bounded-query broker server.
 *
 * Listens on a single Unix domain socket. The container has
 * `network_mode: none`, so this socket — shared with the agent through one
 * bind mount — is the broker's entire attack surface.
 *
 * One route exists:
 *   POST /query   the bounded-query API
 *
 * The agent-visible socket has no `/health` route. The compose healthcheck
 * instead polls for a broker-internal ready file written by `main()` after
 * the socket starts accepting connections. This removes a distinguishable
 * extra response (the health status body) from the agent-observable surface.
 *
 * `/query` always answers `200` with a canonical result body: `{"status":
 * "ok","result":<value>}` or `{"status":"error"}` — status code and headers
 * are identical either way, and every failure class collapses to the same
 * error body. For any invocation that reached workspace creation, the
 * response is additionally held until a fixed timing-bucket boundary (see
 * `./scheduler`) before being sent, so response latency does not leak
 * unbucketed secret-dependent signal either.
 */

const RESULT_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
// Give a nearly-complete invocation a chance to finish broker cleanup before
// force-removing this run's containers. Longer queries are interrupted so
// Compose shutdown remains bounded; host teardown owns private-root removal.
const SHUTDOWN_GRACE_MS = 1_000;

function sendResult(res, body) {
  res.writeHead(200, { ...RESULT_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer(deps) {
  const { broker, audit } = deps;

  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/query') {
      // Not part of the API. Answer with the canonical error rather than a
      // distinguishable 404/405 so probing the surface yields no extra signal.
      sendResult(res, CANONICAL_ERROR_JSON);
      req.resume();
      return;
    }

    readBoundedBody(req)
      .then((body) => {
        if (body.error !== undefined) {
          audit.failure('framing', 'body-rejected', body.error);
          return broker.handle(undefined, (result) => sendResult(res, result));
        }

        const framed = buildRequestFromFrame(req.headers, req.rawHeaders, body.script);
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
  });
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
  const runner = createQueryRunner(config);

  // Fail closed before accepting requests and reconcile containers left by a
  // prior broker process for this exact run. Queries never pull or fall back.
  await runner.assertAvailable();
  await runner.reconcileRun(runId);

  const broker = createBroker({ config, seedMap: seeds, runId, audit, runner });
  const server = createServer({ broker, audit });

  await listenOnSocket(server, config, audit);

  // Write the ready file AFTER the socket is accepting connections. The
  // compose healthcheck polls this file in the broker-only control mount.
  fs.mkdirSync(config.controlDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.readyPath, '', { mode: 0o644 });

  audit.lifecycle('listening', {
    socket: config.socketPath,
    repos: seeds.size,
    backend: config.queryBackend,
    maxInvocations: config.maxInvocations,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    const forcedExit = setTimeout(() => process.exit(1), 5000);
    forcedExit.unref();
    try {
      await Promise.race([
        broker.drain(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
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
    process.stderr.write(`[bounded-query] broker failed to start: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, listenOnSocket };
