'use strict';

const fs = require('fs');
const http = require('http');
const { createAuditLog } = require('./audit');
const { createBroker } = require('./broker');
const { loadConfig, loadSeedMap } = require('./config');
const { buildRequestFromFrame, readBoundedBody } = require('./framing');
const { CANONICAL_ERROR_RESULT_JSON } = require('./protocol');
const { assertProbeImageAvailable } = require('./probe-runner');

/**
 * Sealed-probe broker server.
 *
 * Listens on a single Unix domain socket. The container has
 * `network_mode: none`, so this socket — shared with the agent through one
 * bind mount — is the broker's entire attack surface.
 *
 * One route exists:
 *   POST /probe   the sealed-probe API
 *
 * The agent-visible socket has no `/health` route. The compose healthcheck
 * instead polls for a broker-internal ready file written by `main()` after
 * the socket starts accepting connections. This removes a distinguishable
 * fifth response (the health status body) from the agent-observable surface.
 *
 * `/probe` always answers `200` with a canonical result body. Status codes,
 * headers, and bodies are identical for success and for every failure class,
 * so the response carries exactly one of the four permitted symbols and
 * nothing else.
 */

const RESULT_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

function sendResult(res, body) {
  res.writeHead(200, { ...RESULT_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer(deps) {
  const { broker, audit } = deps;

  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/probe') {
      // Not part of the API. Answer with the canonical error rather than a
      // distinguishable 404/405 so probing the surface yields no extra signal.
      sendResult(res, CANONICAL_ERROR_RESULT_JSON);
      req.resume();
      return;
    }

    readBoundedBody(req)
      .then((body) => {
        if (body.error !== undefined) {
          audit.failure('framing', 'body-rejected', body.error);
          sendResult(res, CANONICAL_ERROR_RESULT_JSON);
          return undefined;
        }

        const framed = buildRequestFromFrame(req.headers, req.rawHeaders, body.script);
        if (framed.error !== undefined) {
          audit.failure('framing', 'frame-rejected', framed.error);
          sendResult(res, CANONICAL_ERROR_RESULT_JSON);
          return undefined;
        }

        return broker.handle(framed.request).then((result) => sendResult(res, result));
      })
      .catch((error) => {
        audit.failure('server', 'unhandled-error', error && error.message);
        if (!res.headersSent) sendResult(res, CANONICAL_ERROR_RESULT_JSON);
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

  // Fail closed before accepting a single request: an invocation must never
  // trigger a registry pull, and the broker has no network to perform one.
  await assertProbeImageAvailable(config.probeImage);

  const broker = createBroker({ config, seedMap: seeds, runId, audit });
  const server = createServer({ broker, audit });

  await listenOnSocket(server, config, audit);

  // Write the ready file AFTER the socket is accepting connections. The
  // compose healthcheck polls this file — it is broker-internal and not
  // accessible on the agent-visible socket.
  fs.writeFileSync(config.readyPath, '', { mode: 0o644 });

  audit.lifecycle('listening', {
    socket: config.socketPath,
    repos: seeds.size,
    runtime: config.dockerRuntime || 'default',
    maxInvocations: config.maxInvocations,
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[sealed-probe] broker failed to start: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, listenOnSocket };
