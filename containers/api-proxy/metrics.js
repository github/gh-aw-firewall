/**
 * In-memory metrics collection for AWF API Proxy.
 *
 * Provides counters, histograms with fixed buckets, and gauges.
 * Memory-bounded: no arrays that grow with request count.
 * Zero external dependencies.
 */

'use strict';

const HISTOGRAM_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

const startTime = Date.now();

// ── Counters ──────────────────────────────────────────────────────────
// Key format: "counterName:label1:label2:..."
const counters = {};

// ── Histograms ────────────────────────────────────────────────────────
// histograms[name][labelKey] = { buckets: { 10: n, 50: n, ... , '+Inf': n }, sum: n, count: n }
const histograms = {};

// ── Gauges ────────────────────────────────────────────────────────────
// gauges[name][labelKey] = number
const gauges = {};

/**
 * Build a colon-separated label key from an object.
 * @param {object} labels - e.g. { provider: "openai", method: "POST", status_class: "2xx" }
 * @returns {string}
 */
function labelKey(labels) {
  if (!labels || typeof labels !== 'object') return '_';
  const vals = Object.values(labels);
  return vals.length > 0 ? vals.join(':') : '_';
}

/**
 * Derive the status class string from an HTTP status code.
 * @param {number} status
 * @returns {string} e.g. "2xx", "4xx", "5xx"
 */
function statusClass(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return `${Math.floor(status / 100)}xx`;
}

// ── Counter operations ────────────────────────────────────────────────

/**
 * Increment a counter.
 * @param {string} name   - Counter name (e.g. "requests_total")
 * @param {object} labels - Label key/value pairs
 * @param {number} [value=1]
 */
function increment(name, labels, value = 1) {
  const key = `${name}:${labelKey(labels)}`;
  counters[key] = (counters[key] || 0) + value;
}

// ── Histogram operations ──────────────────────────────────────────────

/**
 * Record an observation in a histogram.
 * @param {string} name   - Histogram name (e.g. "request_duration_ms")
 * @param {number} value  - Observed value
 * @param {object} labels - Label key/value pairs
 */
function observe(name, value, labels) {
  const lk = labelKey(labels);

  if (!histograms[name]) histograms[name] = {};
  if (!histograms[name][lk]) {
    const buckets = {};
    for (const b of HISTOGRAM_BUCKETS) buckets[b] = 0;
    buckets['+Inf'] = 0;
    histograms[name][lk] = { buckets, sum: 0, count: 0 };
  }

  const h = histograms[name][lk];
  h.sum += value;
  h.count += 1;
  for (const b of HISTOGRAM_BUCKETS) {
    if (value <= b) h.buckets[b]++;
  }
  h.buckets['+Inf']++;
}

/**
 * Calculate a percentile from histogram buckets using linear interpolation.
 * @param {{ buckets: object, count: number }} h
 * @param {number} p - Percentile (0–1), e.g. 0.5 for p50
 * @returns {number}
 */
function percentileFromHistogram(h, p) {
  if (h.count === 0) return 0;
  const target = p * h.count;

  let prev = 0;
  let prevBound = 0;

  for (const b of HISTOGRAM_BUCKETS) {
    const cum = h.buckets[b];
    if (cum >= target) {
      // Linear interpolation within this bucket
      const fraction = cum === prev ? 0 : (target - prev) / (cum - prev);
      return prevBound + fraction * (b - prevBound);
    }
    prev = cum;
    prevBound = b;
  }

  // All values above the last bucket — return last bucket upper bound
  return HISTOGRAM_BUCKETS[HISTOGRAM_BUCKETS.length - 1];
}

// ── Gauge operations ──────────────────────────────────────────────────

function gaugeInc(name, labels) {
  const lk = labelKey(labels);
  if (!gauges[name]) gauges[name] = {};
  gauges[name][lk] = (gauges[name][lk] || 0) + 1;
}

function gaugeDec(name, labels) {
  const lk = labelKey(labels);
  if (!gauges[name]) gauges[name] = {};
  gauges[name][lk] = (gauges[name][lk] || 0) - 1;
}

function gaugeSet(name, labels, value) {
  const lk = labelKey(labels);
  if (!gauges[name]) gauges[name] = {};
  gauges[name][lk] = value;
}

// ── Snapshot helpers ──────────────────────────────────────────────────

/**
 * Return full metrics object for /metrics endpoint.
 */
function getMetrics() {
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

  // Build histogram output with percentiles
  const histOut = {};
  for (const [name, byLabel] of Object.entries(histograms)) {
    histOut[name] = {};
    for (const [lk, h] of Object.entries(byLabel)) {
      histOut[name][lk] = {
        p50: Math.round(percentileFromHistogram(h, 0.5)),
        p90: Math.round(percentileFromHistogram(h, 0.9)),
        p99: Math.round(percentileFromHistogram(h, 0.99)),
        count: h.count,
        sum: Math.round(h.sum),
        buckets: { ...h.buckets },
      };
    }
  }

  return {
    counters: { ...counters },
    histograms: histOut,
    gauges: {
      ...gauges,
      uptime_seconds: uptimeSec,
    },
  };
}

/**
 * Return compact summary for /health endpoint.
 */
function getSummary() {
  let totalRequests = 0;
  let totalErrors = 0;
  let activeRequests = 0;

  for (const [key, val] of Object.entries(counters)) {
    if (key.startsWith('requests_total:')) totalRequests += val;
    if (key.startsWith('requests_errors_total:')) totalErrors += val;
  }

  if (gauges.active_requests) {
    for (const val of Object.values(gauges.active_requests)) {
      activeRequests += val;
    }
  }

  // Average latency across all providers
  let totalDuration = 0;
  let totalCount = 0;
  if (histograms.request_duration_ms) {
    for (const h of Object.values(histograms.request_duration_ms)) {
      totalDuration += h.sum;
      totalCount += h.count;
    }
  }

  return {
    total_requests: totalRequests,
    total_errors: totalErrors,
    active_requests: activeRequests,
    avg_latency_ms: totalCount > 0 ? Math.round(totalDuration / totalCount) : 0,
  };
}

module.exports = {
  statusClass,
  increment,
  observe,
  gaugeInc,
  gaugeDec,
  gaugeSet,
  getMetrics,
  getSummary,
  // Exported for testing
  HISTOGRAM_BUCKETS,
};
