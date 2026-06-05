'use strict';

const SCOPE_NAME = 'awf-api-proxy';

/**
 * Parse the OTEL_EXPORTER_OTLP_HEADERS format: comma-separated "key=value" pairs.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseOtlpHeaders(raw) {
  const headers = {};
  if (!raw) return headers;
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/** @param {[number, number]} hrTime  HrTime as [seconds, nanoseconds] */
function hrTimeToNanoString(hrTime) {
  return String(BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]));
}

function serializeAttrValue(val) {
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { boolValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { intValue: String(val) } : { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(serializeAttrValue) } };
  }
  return { stringValue: String(val) };
}

function serializeAttributes(attrs) {
  return Object.entries(attrs || {}).map(([key, val]) => ({
    key,
    value: serializeAttrValue(val),
  }));
}

function serializeEvent(event) {
  return {
    name: event.name,
    timeUnixNano: hrTimeToNanoString(event.time),
    attributes: serializeAttributes(event.attributes || {}),
    droppedAttributesCount: event.droppedAttributesCount || 0,
  };
}

// OTLP proto SpanKind is 1-indexed relative to the OTEL SDK's 0-indexed enum.
function toOtlpKind(kind) { return kind + 1; }

// OTLP StatusCode matches SpanStatusCode: 0=Unset 1=Ok 2=Error.
function serializeStatus(status) {
  const obj = { code: status.code || 0 };
  if (status.message) obj.message = status.message;
  return obj;
}

function serializeSpan(span) {
  const ctx = span.spanContext();
  const out = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    name: span.name,
    kind: toOtlpKind(span.kind),
    startTimeUnixNano: hrTimeToNanoString(span.startTime),
    endTimeUnixNano: hrTimeToNanoString(span.endTime),
    attributes: serializeAttributes(span.attributes),
    events: (span.events || []).map(serializeEvent),
    links: [],
    status: serializeStatus(span.status),
    droppedAttributesCount: span._droppedAttributesCount || 0,
    droppedEventsCount: span._droppedEventsCount || 0,
    droppedLinksCount: span._droppedLinksCount || 0,
  };
  if (span.parentSpanId) out.parentSpanId = span.parentSpanId;
  return out;
}

/**
 * Build the OTLP/JSON `resourceSpans` envelope.
 * @param {import('@opentelemetry/sdk-trace-base').ReadableSpan[]} spans
 * @param {import('@opentelemetry/resources').Resource} resource
 * @returns {object[]}
 */
function buildResourceSpans(spans, resource) {
  return [{
    resource: {
      attributes: serializeAttributes(resource.attributes),
      droppedAttributesCount: 0,
    },
    scopeSpans: [{
      scope: { name: SCOPE_NAME, version: '' },
      spans: spans.map(serializeSpan),
    }],
  }];
}

module.exports = {
  parseOtlpHeaders,
  hrTimeToNanoString,
  serializeAttrValue,
  serializeAttributes,
  serializeEvent,
  toOtlpKind,
  serializeStatus,
  serializeSpan,
  buildResourceSpans,
};
