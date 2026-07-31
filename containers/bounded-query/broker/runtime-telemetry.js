'use strict';

const fs = require('fs');
const path = require('path');

const PRIMARY_BACKENDS = new Set(['docker', 'gvisor', 'sbx']);
const QUERY_BACKENDS = new Set(['docker', 'gvisor', 'sbx']);
const LIFECYCLE_CLASSES = new Set(['preflight', 'startup', 'query', 'cleanup']);
const CAPABILITY_STATES = new Set(['supported', 'unavailable', 'blocked']);
const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function assertTelemetryValue(allowed, value, field) {
  if (!allowed.has(value)) throw new Error(`Invalid bounded-query telemetry ${field}`);
}

function buildRuntimeTelemetryRecord(event) {
  assertTelemetryValue(PRIMARY_BACKENDS, event.primaryBackend, 'primaryBackend');
  assertTelemetryValue(QUERY_BACKENDS, event.queryBackend, 'queryBackend');
  assertTelemetryValue(LIFECYCLE_CLASSES, event.lifecycleClass, 'lifecycleClass');
  assertTelemetryValue(CAPABILITY_STATES, event.capabilityState, 'capabilityState');
  if (typeof event.category !== 'string' || !CATEGORY_PATTERN.test(event.category)) {
    throw new Error('Invalid bounded-query telemetry category');
  }
  return Object.freeze({
    primaryBackend: event.primaryBackend,
    queryBackend: event.queryBackend,
    lifecycleClass: event.lifecycleClass,
    capabilityState: event.capabilityState,
    category: event.category,
  });
}

function createRuntimeTelemetry(auditDir) {
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const telemetryPath = path.join(auditDir, 'runtime-telemetry.jsonl');
  let fd = fs.openSync(telemetryPath, 'a', 0o600);
  return {
    emit(event) {
      const record = buildRuntimeTelemetryRecord(event);
      if (fd === undefined) return;
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      } catch {
        process.stderr.write('[bounded-query] runtime telemetry unavailable\n');
        try {
          fs.closeSync(fd);
        } catch {
          // The generic telemetry failure above is the only safe diagnostic.
        }
        fd = undefined;
      }
    },
  };
}

module.exports = { buildRuntimeTelemetryRecord, createRuntimeTelemetry };
