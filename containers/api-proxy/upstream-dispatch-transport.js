'use strict';

const { rememberInjectedCredentials } = require('./credential-protection');

function signOutboundRequest({
  requestSigner, requestHeaders, body, req, upstreamPath, targetHost, budgetAttempt,
  span, res, requestId, provider, startTime,
}, { otel, handleRequestError, metrics }) {
  if (!requestSigner) return requestHeaders;

  try {
    const outboundHeaders = requestSigner({
      method: req.method,
      path: upstreamPath,
      headers: requestHeaders,
      body,
      targetHost,
    });
    rememberInjectedCredentials(req, Object.fromEntries(Object.entries(outboundHeaders)
      .filter(([name]) => ['authorization', 'x-amz-security-token'].includes(name.toLowerCase()))));
    return outboundHeaders;
  } catch (err) {
    budgetAttempt.settleMissing();
    otel.endSpanError(span, err, 503);
    handleRequestError(err, {
      res, requestId, provider, req, targetHost, startTime,
      statusCode: 503,
      clientMessage: 'AWS request signing unavailable',
      extraMetrics: () => {
        metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
      },
    });
    return null;
  }
}

function buildUpstreamRequestOptions({
  targetScheme, targetHost, upstreamPath, req, outboundHeaders, cancellation,
}, { http, https, proxyAgent }) {
  // Keep the authority intact for Host headers/signing, but dial hostname and
  // port separately (including for IPv6 literals).
  const isHttp = targetScheme === 'http';
  const mod = isHttp ? http : https;
  const targetUrl = new URL(`${targetScheme}://${targetHost}`);
  const options = {
    hostname: targetUrl.hostname.replace(/^\[|\]$/g, ''),
    port: targetUrl.port ? Number(targetUrl.port) : (isHttp ? 80 : 443),
    path: upstreamPath,
    method: req.method, headers: outboundHeaders,
    agent: proxyAgent,
    signal: cancellation.controller.signal,
    ...(req.awfTrustedService ? { rejectUnauthorized: true } : {}),
  };
  return { mod, options };
}

module.exports = { signOutboundRequest, buildUpstreamRequestOptions };
