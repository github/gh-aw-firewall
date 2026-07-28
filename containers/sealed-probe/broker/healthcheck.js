'use strict';

const fs = require('fs');
const { READY_PATH } = require('./config');

/**
 * Compose healthcheck for the broker.
 *
 * Checks for the broker-internal ready file written by `main()` in server.js
 * once the socket is accepting connections. This avoids hitting the
 * agent-visible `/probe` socket, which has only one route and no health
 * endpoint. Exits non-zero if the ready file is absent or unreadable.
 */

try {
  fs.accessSync(READY_PATH, fs.constants.F_OK);
  process.exit(0);
} catch {
  process.exit(1);
}
