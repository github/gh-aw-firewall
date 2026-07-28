'use strict';

const http = require('http');

/**
 * Compose healthcheck for the broker.
 *
 * Runs inside the broker container and talks to the same Unix socket the
 * agent uses, so a healthy result means the agent's only entry point is
 * actually accepting connections. Exits non-zero otherwise.
 */

const SOCKET_PATH = '/run/awf-sealed-probe/broker.sock';

const request = http.request(
  { socketPath: SOCKET_PATH, path: '/health', method: 'GET', timeout: 2000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on('error', () => process.exit(1));
request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});
request.end();
