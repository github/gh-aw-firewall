'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const { HttpsProxyAgent } = require('https-proxy-agent');

const { buildResourceSpans } = require('./otel-serialization');

const EXPORT_TIMEOUT_MS = 10_000;
const AWF_VERSION = process.env.AWF_VERSION || '0.0.0-dev';
const OTEL_SPAN_SCHEMA = `otel-span/v${AWF_VERSION}`;

/**
 * A minimal SpanExporter that POSTs OTLP/JSON to an HTTP(S) collector,
 * routing traffic through the Squid proxy when HTTPS_PROXY is set.
 *
 * This replaces the standard `@opentelemetry/exporter-trace-otlp-http` solely
 * to gain `HttpsProxyAgent` support — the api-proxy container's iptables rules
 * require all external traffic to exit via Squid.
 */
class ProxyAwareOtlpExporter {
  /**
   * @param {object} opts
   * @param {string} opts.url        - OTLP base URL (with or without /v1/traces suffix)
   * @param {Record<string,string>} opts.headers - Extra request headers (auth etc.)
   * @param {string|null} opts.httpsProxy - Squid proxy URL, or falsy to connect directly
   * @param {import('@opentelemetry/resources').Resource} opts.resource
   */
  constructor({ url, headers, httpsProxy, resource }) {
    const parsed = new URL(url);
    const trimmedPath = parsed.pathname.replace(/\/+$/, '');
    if (trimmedPath === '' || trimmedPath === '/') {
      parsed.pathname = '/v1/traces';
    } else if (trimmedPath.endsWith('/v1/traces')) {
      parsed.pathname = trimmedPath;
    } else {
      parsed.pathname = `${trimmedPath}/v1/traces`;
    }
    this._parsedUrl = parsed;
    this._headers = headers || {};
    this._agent = httpsProxy ? new HttpsProxyAgent(httpsProxy) : undefined;
    this._resource = resource;
  }

  /**
   * @param {import('@opentelemetry/sdk-trace-base').ReadableSpan[]} spans
   * @param {(result: import('@opentelemetry/core').ExportResult) => void} resultCallback
   */
  export(spans, resultCallback) {
    if (!spans || spans.length === 0) { resultCallback({ code: 0 }); return; }
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resultCallback(result);
    };

    let bodyBuf;
    try {
      bodyBuf = Buffer.from(JSON.stringify({
        resourceSpans: buildResourceSpans(spans, this._resource),
      }), 'utf8');
    } catch (err) {
      settle({ code: 1, error: err });
      return;
    }

    const isHttps = this._parsedUrl.protocol === 'https:';
    const Transport = isHttps ? https : http;
    const port = this._parsedUrl.port
      ? parseInt(this._parsedUrl.port, 10)
      : (isHttps ? 443 : 80);

    const reqOptions = {
      hostname: this._parsedUrl.hostname,
      port,
      path: `${this._parsedUrl.pathname}${this._parsedUrl.search || ''}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        ...this._headers,
      },
    };
    if (this._agent) reqOptions.agent = this._agent;

    let req;
    try {
      req = Transport.request(reqOptions, (res) => {
        res.on('data', () => {});
        res.on('error', (err) => { settle({ code: 1, error: err }); });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          settle({ code: ok ? 0 : 1 });
        });
      });
    } catch (err) {
      settle({ code: 1, error: err });
      return;
    }
    req.setTimeout(EXPORT_TIMEOUT_MS, () => {
      req.destroy(new Error(`OTLP export timeout after ${EXPORT_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => { settle({ code: 1, error: err }); });
    req.write(bodyBuf);
    req.end();
  }

  shutdown() { return Promise.resolve(); }
}

/**
 * Writes span data as NDJSON to /var/log/api-proxy/otel.jsonl.
 * Used when no OTLP endpoint is configured.  Mirrors the MCPG pattern at
 * /tmp/gh-aw/otel.jsonl.  All writes are best-effort — errors are silently
 * swallowed so a missing or unwritable log directory never breaks the proxy.
 */
class FileSpanExporter {
  constructor(filePath) {
    this._filePath = filePath;
    this._stream = null;
  }

  _getStream() {
    if (this._stream) return this._stream;
    try {
      this._stream = fs.createWriteStream(this._filePath, { flags: 'a', mode: 0o644 });
      this._stream.on('error', () => { this._stream = null; });
    } catch { return null; }
    return this._stream;
  }

  export(spans, resultCallback) {
    const stream = this._getStream();
    if (stream) {
      for (const span of spans || []) {
        try {
          const ctx = span.spanContext();
          const record = {
            _schema: OTEL_SPAN_SCHEMA,
            timestamp: new Date().toISOString(),
            event: 'otel_span',
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            parentSpanId: span.parentSpanId || null,
            name: span.name,
            kind: span.kind,
            startTimeMs: span.startTime[0] * 1000 + Math.round(span.startTime[1] / 1e6),
            endTimeMs: span.endTime[0] * 1000 + Math.round(span.endTime[1] / 1e6),
            attributes: span.attributes || {},
            events: (span.events || []).map(e => ({ name: e.name, attributes: e.attributes || {} })),
            status: span.status,
          };
          stream.write(`${JSON.stringify(record)}\n`);
        } catch { /* best-effort */ }
      }
    }
    resultCallback({ code: 0 });
  }

  shutdown() {
    return new Promise((resolve) => {
      if (this._stream) {
        this._stream.end(resolve);
        this._stream = null;
      } else {
        resolve();
      }
    });
  }
}

/**
 * Fan-out exporter that sends spans to multiple OTLP endpoints concurrently.
 * Partial failures on individual endpoints do not block export to others.
 */
class FanOutSpanExporter {
  /**
   * @param {ProxyAwareOtlpExporter[]} exporters - Array of per-endpoint exporters
   */
  constructor(exporters) {
    this._exporters = exporters;
  }

  export(spans, resultCallback) {
    if (!spans || spans.length === 0 || this._exporters.length === 0) {
      resultCallback({ code: 0 });
      return;
    }

    let pending = this._exporters.length;
    let anySuccess = false;

    const onDone = (result) => {
      if (result.code === 0) anySuccess = true;
      pending--;
      if (pending === 0) {
        resultCallback({ code: anySuccess ? 0 : 1 });
      }
    };

    for (const exporter of this._exporters) {
      try {
        exporter.export(spans, onDone);
      } catch {
        onDone({ code: 1 });
      }
    }
  }

  shutdown() {
    return Promise.all(this._exporters.map(e => e.shutdown()));
  }
}

module.exports = {
  ProxyAwareOtlpExporter,
  FileSpanExporter,
  FanOutSpanExporter,
};
