'use strict';

const OTEL_ENV_KEYS = [
  'GH_AW_OTLP_ENDPOINTS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
  'GITHUB_AW_OTEL_TRACE_ID',
  'GITHUB_AW_OTEL_PARENT_SPAN_ID',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'AWF_VERSION',
];

function loadOtelModule(envOverrides = {}) {
  const saved = {};
  for (const k of OTEL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  jest.resetModules();
  const mod = require('../otel');

  for (const k of OTEL_ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  return mod;
}

module.exports = { loadOtelModule, OTEL_ENV_KEYS };
