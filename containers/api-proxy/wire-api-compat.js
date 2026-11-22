'use strict';

const {
  WireApiCompatibilityError, endpointForPath,
  replaceUpstreamEndpoint, carryForwardWireApiCompatibility,
} = require('./wire-api/shared');
const {
  translateCopilotWireApi, translateChatRequest, translateResponsesRequest,
} = require('./wire-api/request-translation');
const {
  transformChatResponse, transformResponsesResponse, transformWireApiResponseBody,
} = require('./wire-api/response-translation');
const { createWireApiSseTransform } = require('./wire-api/sse-transforms');

module.exports = {
  WireApiCompatibilityError,
  endpointForPath,
  translateCopilotWireApi,
  translateChatRequest,
  translateResponsesRequest,
  replaceUpstreamEndpoint,
  transformWireApiResponseBody,
  createWireApiSseTransform,
  carryForwardWireApiCompatibility,
  _testing: {
    endpointForPath,
    translateChatRequest,
    translateResponsesRequest,
    transformChatResponse,
    transformResponsesResponse,
  },
};
