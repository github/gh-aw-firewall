'use strict';

/**
 * Extract billing/quota information from upstream response headers.
 *
 * CAPI returns quota snapshots as `X-Quota-Snapshot-<Type>` headers with
 * URL-encoded fields: ent (entitlement), ov (overage), ovPerm (overage allowed),
 * rem (remaining %), rst (reset date).
 *
 * Also captures X-RateLimit-* headers from CAPI responses.
 *
 * @param {Record<string, string|string[]>} headers - Response headers
 * @returns {object|null} Billing info object, or null if no billing headers present
 */
function extractBillingHeaders(headers) {
  const billing = {};
  let hasBilling = false;

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-quota-snapshot-')) {
      const quotaType = lower.slice('x-quota-snapshot-'.length);
      try {
        const params = new URLSearchParams(String(value));
        const snapshot = {};
        for (const [k, v] of params) snapshot[k] = v;
        billing[`quota_${quotaType}`] = snapshot;
      } catch {
        billing[`quota_${quotaType}_raw`] = String(value);
      }
      hasBilling = true;
    }
  }

  if (headers['x-ratelimit-limit']) {
    billing.rate_limit = headers['x-ratelimit-limit'];
    billing.rate_remaining = headers['x-ratelimit-remaining'];
    billing.rate_reset = headers['x-ratelimit-reset'];
    hasBilling = true;
  }

  return hasBilling ? billing : null;
}

module.exports = {
  extractBillingHeaders,
};
