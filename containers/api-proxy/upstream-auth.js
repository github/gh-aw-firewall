'use strict';

const { mergeInjectedHeaders } = require('./request-headers');

function createFailBrokerAuth({ metrics, otel }) {
  return ({ res, req, provider, span }) => {
    metrics.gaugeDec('active_requests', { provider });
    otel.endSpan(span, 503);
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    if (req.awfRouting) req.awfRouting.localError = { code: 'token_broker_unavailable', type: 'authentication_error' };
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'token_broker_unavailable', type: 'authentication_error',
      message: 'Copilot token broker authentication unavailable' } }));
  };
}

function createSendAuthenticatedRequest({ getProviderAdapter, dispatchUpstreamRequest, failBrokerAuth }) {
  return function sendUpstreamRequest(requestHeaders, ctx) {
    const adapter = getProviderAdapter?.(ctx.provider);
    if (adapter?.trustedService) ctx.req.awfTrustedService = true;
    if (!adapter?.renewableAuth) return dispatchUpstreamRequest(requestHeaders, ctx);
    return adapter.getAuthHeaders({ method: ctx.req.method, url: ctx.upstreamPath, headers: ctx.req.headers })
      .then(authHeaders => {
        const headers = Object.fromEntries(Object.entries(requestHeaders)
          .filter(([key]) => key.toLowerCase() !== 'authorization'));
        mergeInjectedHeaders(headers, authHeaders, ctx.targetHost);
        dispatchUpstreamRequest(headers, ctx);
      }).catch(() => failBrokerAuth(ctx));
  };
}

module.exports = {
  createFailBrokerAuth,
  createSendAuthenticatedRequest,
};
