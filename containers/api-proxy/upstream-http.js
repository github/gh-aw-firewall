'use strict';

const { rebuildBodyFramingHeaders } = require('./upstream-request-utils');
const { createFailBrokerAuth, createSendAuthenticatedRequest } = require('./upstream-auth');
const { getFallbackModels } = require('./model-fallback-chain');
const {
  createDispatchUpstreamRequest,
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
} = require('./upstream-dispatch');

/**
 * Resolve renewable credentials immediately before each actual attempt,
 * including model/endpoint retries. No refresh timer can touch active streams.
 */
function createSendUpstreamRequest(deps) {
  const failBrokerAuth = createFailBrokerAuth(deps);
  const dispatchUpstreamRequest = createDispatchUpstreamRequest({
    ...deps,
    getFallbackModels: deps.getFallbackModels === undefined ? getFallbackModels : deps.getFallbackModels,
    failBrokerAuth,
    sendUpstreamRequest: (...args) => sendUpstreamRequest(...args),
  });
  const sendUpstreamRequest = createSendAuthenticatedRequest({
    getProviderAdapter: deps.getProviderAdapter === undefined ? null : deps.getProviderAdapter,
    dispatchUpstreamRequest,
    failBrokerAuth,
  });
  return sendUpstreamRequest;
}

module.exports = {
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  rebuildBodyFramingHeaders,
  createSendUpstreamRequest,
};
