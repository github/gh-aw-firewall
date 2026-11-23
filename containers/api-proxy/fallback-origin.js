'use strict';

const { canonicalEndpoint } = require('./upstream-request-utils');
const { protocolForPath } = require('./cross-provider-fallback');
const { getRequestModel } = require('./model-fallback-chain');

function buildFallbackOrigin({
  body, targetHost, upstreamPath, req, provider, requestSigner, targetScheme,
  codexCompatibility, wireApiCompatibility, wireApiSourceBody,
  wireApiEndpointRetryAttempted, requestHeaders, fallbackOrigin,
}) {
  // Capture the agent-facing request before any budget rewrite. Later attempts
  // on another provider are rebuilt from this protocol, not a translated body.
  return fallbackOrigin || {
    provider,
    protocol: protocolForPath(req?.url || upstreamPath),
    sourceBody: req.awfFallbackSourceBody || wireApiSourceBody || body,
    model: (req.awfResolverFallback?.provider === provider ? req.awfResolverFallback.fromModel : null) ||
      req.awfRecoveryAttempts?.[0]?.model || getRequestModel(body, upstreamPath)?.model || null,
    endpoint: canonicalEndpoint(req?.url || upstreamPath),
    body,
    upstreamPath,
    requestHeaders,
    targetHost,
    requestSigner,
    targetScheme,
    codexCompatibility,
    wireApiCompatibility,
    wireApiSourceBody,
    wireApiEndpointRetryAttempted,
    failures: req.awfModelFallback?.failures || [],
  };
}

module.exports = { buildFallbackOrigin };
