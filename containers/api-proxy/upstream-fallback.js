'use strict';

const { parseBodyAsObject } = require('./body-utils');
const {
  getFallbackUpstreamEndpoint,
} = require('./cross-provider-fallback');
const {
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
} = require('./wire-api-compat');

function rebuildCopilotWireApiFallback(sourceBody, nextModel, req, upstreamPath, preserveEndpoint = false) {
  const requestedEndpoint = endpointForPath(req?.url);
  const parsed = parseBodyAsObject(sourceBody);
  if (!requestedEndpoint || !parsed || typeof parsed.model !== 'string') return null;

  parsed.model = nextModel;
  const nextSourceBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  const plannedEndpoint = endpointForPath(getFallbackUpstreamEndpoint(
    'copilot', nextModel, req.url, preserveEndpoint, req.awfRuntimePricing,
  )) || requestedEndpoint;
  const translated = plannedEndpoint === requestedEndpoint ? null
    : translateCopilotWireApi(nextSourceBody, req.url, { upstreamEndpoint: plannedEndpoint });
  const compatibility = translated?.compatibility || {
    requestedEndpoint,
    upstreamEndpoint: requestedEndpoint,
    passthrough: true,
  };
  req.awfRouting?.onEndpointTranslation?.(compatibility);
  return {
    body: translated?.body || nextSourceBody,
    upstreamPath: replaceUpstreamEndpoint(
      upstreamPath,
      compatibility.upstreamEndpoint,
    ),
    wireApiCompatibility: compatibility,
    wireApiSourceBody: nextSourceBody,
  };
}

module.exports = {
  rebuildCopilotWireApiFallback,
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
};
