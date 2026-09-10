'use strict';

const OTEL_ENV_KEYS = [
  'GH_AW_OTLP_ENDPOINTS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
  'GITHUB_AW_OTEL_TRACE_ID',
  'GITHUB_AW_OTEL_PARENT_SPAN_ID',
  'GH_AW_OTLP_WORKLOAD_IDENTITY',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'AWF_VERSION',
];

function loadOtelModule(envOverrides = {}, { spanProcessor, onExporter } = {}) {
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
  if (spanProcessor || onExporter) {
    jest.doMock('@opentelemetry/sdk-trace-node', () => {
      const sdk = jest.requireActual('@opentelemetry/sdk-trace-node');
      const overrides = {};
      if (spanProcessor) {
        overrides.NodeTracerProvider = class extends sdk.NodeTracerProvider {
          constructor(options) {
            super({ ...options, spanProcessors: [spanProcessor] });
          }
        };
      }
      if (onExporter) {
        overrides.BatchSpanProcessor = class extends sdk.BatchSpanProcessor {
          constructor(exporter) {
            super(exporter);
            onExporter(exporter);
          }
        };
      }
      return { ...sdk, ...overrides };
    });
  }
  const mod = require('../otel');
  jest.dontMock('@opentelemetry/sdk-trace-node');

  for (const k of OTEL_ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  return mod;
}

module.exports = { loadOtelModule, OTEL_ENV_KEYS };
