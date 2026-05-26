'use strict';

const { logRequest } = require('./logging');

/** Map of headerName → Set of rejected values, learned from upstream 400 responses. */
const deprecatedHeaderValues = new Map();
const MAX_CACHED_VALUES_PER_HEADER = 200;

/**
 * Pattern to detect header-value rejection errors from Anthropic.
 * Matches: Unexpected value(s) `<value>` for the `<header>` header
 */
const DEPRECATED_HEADER_PATTERN = /Unexpected value\(s\)\s+`([^`]+)`\s+for the `([^`]+)` header/;

function normalizeHeaderValue(value) {
  if (!value) return '';
  return Array.isArray(value) ? value.join(',') : String(value);
}

function splitHeaderValue(value) {
  return normalizeHeaderValue(value).split(',').map(s => s.trim()).filter(Boolean);
}

function updateHeader(headers, headerName, values) {
  if (!values.length) {
    delete headers[headerName];
    return;
  }
  headers[headerName] = values.join(',');
}

function stripValuesFromHeader(headers, headerName, valuesToStrip) {
  if (!headers[headerName] || !valuesToStrip.size) return null;
  const existingValues = splitHeaderValue(headers[headerName]);
  if (!existingValues.length) {
    delete headers[headerName];
    return { removed: [], remaining: [] };
  }
  const remaining = existingValues.filter(value => !valuesToStrip.has(value));
  const removed = existingValues.filter(value => valuesToStrip.has(value));
  if (!removed.length) return null;
  updateHeader(headers, headerName, remaining);
  return { removed, remaining };
}

function getDeprecatedValuesForHeader(headerName) {
  if (!deprecatedHeaderValues.has(headerName)) {
    deprecatedHeaderValues.set(headerName, new Set());
  }
  return deprecatedHeaderValues.get(headerName);
}

function maybeStripLearnedHeaderValues(headers, requestId, provider) {
  for (const [headerName, rejectedValues] of deprecatedHeaderValues) {
    if (!headers[headerName] || !rejectedValues.size) continue;
    const stripped = stripValuesFromHeader(headers, headerName, rejectedValues);
    if (!stripped) continue;
    logRequest('warn', 'deprecated_header_stripped', {
      request_id: requestId,
      provider,
      header: headerName,
      mode: 'cached',
      removed_values: stripped.removed,
      remaining_values: stripped.remaining,
      message: `Removed deprecated ${headerName} values learned from prior upstream 400 responses`,
    });
  }
}

function parseDeprecatedHeaderFromBody(body) {
  const match = body.toString('utf8').match(DEPRECATED_HEADER_PATTERN);
  if (!match) return null;
  return { value: match[1].trim(), header: match[2].trim() };
}

function learnAndStripDeprecatedHeaderValue(headers, headerName, deprecatedValue, requestId, provider) {
  const rejectedValues = getDeprecatedValuesForHeader(headerName);
  rejectedValues.add(deprecatedValue);
  if (rejectedValues.size > MAX_CACHED_VALUES_PER_HEADER) {
    const oldest = rejectedValues.values().next().value;
    if (oldest !== undefined) rejectedValues.delete(oldest);
  }
  const stripped = stripValuesFromHeader(headers, headerName, new Set([deprecatedValue]));
  if (!stripped) return null;
  logRequest('warn', 'deprecated_header_stripped', {
    request_id: requestId,
    provider,
    header: headerName,
    mode: 'retry',
    removed_values: stripped.removed,
    remaining_values: stripped.remaining,
    message: `Removed deprecated ${headerName} value rejected by upstream: ${deprecatedValue}`,
  });
  return stripped;
}

function resetDeprecatedHeaderValuesForTests() {
  deprecatedHeaderValues.clear();
}

module.exports = {
  getDeprecatedValuesForHeader,
  maybeStripLearnedHeaderValues,
  parseDeprecatedHeaderFromBody,
  learnAndStripDeprecatedHeaderValue,
  resetDeprecatedHeaderValuesForTests,
};
