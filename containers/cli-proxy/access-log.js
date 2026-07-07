'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.AWF_CLI_PROXY_LOG_DIR || '/var/log/cli-proxy';
const LOG_FILE = path.join(LOG_DIR, 'access.jsonl');

// AWF version used to identify schema version in JSONL records.
// Set to the container image version at build time via ARG AWF_VERSION in the Dockerfile.
// Falls back to "0.0.0-dev" for local/un-versioned builds.
const AWF_VERSION = process.env.AWF_VERSION || '0.0.0-dev';
const CLI_PROXY_ACCESS_SCHEMA = `cli-proxy-access/v${AWF_VERSION}`;

let logStream = null;
try {
  if (fs.existsSync(LOG_DIR)) {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o644 });
  }
} catch {
  // Non-fatal: logging to file is best-effort
}

/**
 * Write a structured JSON log entry to the access log file and stderr.
 * Each line is a self-contained JSON object for easy parsing.
 */
function accessLog(entry) {
  const record = { timestamp: new Date().toISOString(), _schema: CLI_PROXY_ACCESS_SCHEMA, ...entry };
  const line = JSON.stringify(record);
  if (logStream) {
    logStream.write(line + '\n');
  }
  // Also emit to stderr so docker logs captures it
  console.error(line);
}

module.exports = {
  CLI_PROXY_ACCESS_SCHEMA,
  accessLog,
};
