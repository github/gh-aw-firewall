'use strict';

const RESPONSES_ENDPOINT = '/responses';
const CHAT_ENDPOINT = '/chat/completions';

class WireApiCompatibilityError extends Error {
  constructor(feature) {
    super(`Cannot translate Copilot request feature '${feature}' between Responses and Chat Completions.`);
    this.name = 'WireApiCompatibilityError';
    this.statusCode = 400;
    this.code = 'unsupported_wire_api_feature';
    this.feature = feature;
  }
}

function endpointForPath(path) {
  if (typeof path !== 'string') return null;
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (pathname.endsWith(RESPONSES_ENDPOINT)) return RESPONSES_ENDPOINT;
  if (pathname.endsWith(CHAT_ENDPOINT)) return CHAT_ENDPOINT;
  return null;
}

function advertisedEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null;
  if (endpoint.endsWith(RESPONSES_ENDPOINT)) return RESPONSES_ENDPOINT;
  if (endpoint.endsWith(CHAT_ENDPOINT)) return CHAT_ENDPOINT;
  return null;
}

function failIfPresent(body, keys) {
  for (const key of keys) {
    if (Object.hasOwn(body, key) && body[key] !== undefined && body[key] !== null && body[key] !== false) {
      throw new WireApiCompatibilityError(key);
    }
  }
}

function ensureOnlyFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new WireApiCompatibilityError(key);
  }
}

function replaceUpstreamEndpoint(path, endpoint) {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : path.slice(queryIndex);
  const replaced = pathname.replace(/\/(?:chat\/completions|responses)\/?$/, endpoint);
  return `${replaced}${query}`;
}

function carryForwardWireApiCompatibility(compatibility) {
  return compatibility || null;
}

module.exports = {
  RESPONSES_ENDPOINT,
  CHAT_ENDPOINT,
  WireApiCompatibilityError,
  endpointForPath,
  advertisedEndpoint,
  failIfPresent,
  ensureOnlyFields,
  replaceUpstreamEndpoint,
  carryForwardWireApiCompatibility,
};
