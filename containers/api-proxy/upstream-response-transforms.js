'use strict';

const {
  transformCodexCompatibleResponseBody,
  createCodexCompatibleSseTransform,
} = require('./codex-compat');
const {
  transformWireApiResponseBody,
  createWireApiSseTransform,
} = require('./wire-api-compat');
const {
  transformProtocolResponseBody,
  createProtocolSseTransforms,
} = require('./cross-provider-fallback');

// JSON transforms return a replacement Buffer or null; SSE transforms are streams.
// Both lists translate protocol first, then wire API, then Codex custom tools.
function selectCompatibilityTransforms({
  compatibilityProvider, protocolTranslation, codexCompatibility, wireApiCompatibility, isStreaming, isJson,
}) {
  if (isJson) {
    return [
      body => transformProtocolResponseBody(body, protocolTranslation),
      body => transformWireApiResponseBody(body, wireApiCompatibility),
      body => transformCodexCompatibleResponseBody(body, codexCompatibility, compatibilityProvider),
    ];
  }
  if (!isStreaming) return [];
  const transforms = [...createProtocolSseTransforms(protocolTranslation)];
  const wireTransform = createWireApiSseTransform(wireApiCompatibility);
  const codexTransform = createCodexCompatibleSseTransform(codexCompatibility, compatibilityProvider);
  if (wireTransform) transforms.push(wireTransform);
  if (codexTransform) transforms.push(codexTransform);
  return transforms;
}

module.exports = { selectCompatibilityTransforms };
