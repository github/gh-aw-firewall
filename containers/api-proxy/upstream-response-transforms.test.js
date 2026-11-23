'use strict';

jest.mock('./cross-provider-fallback', () => ({
  transformProtocolResponseBody: jest.fn(),
  createProtocolSseTransforms: jest.fn(),
}));
jest.mock('./wire-api-compat', () => ({
  transformWireApiResponseBody: jest.fn(),
  createWireApiSseTransform: jest.fn(),
}));
jest.mock('./codex-compat', () => ({
  transformCodexCompatibleResponseBody: jest.fn(),
  createCodexCompatibleSseTransform: jest.fn(),
}));

const { selectCompatibilityTransforms } = require('./upstream-response-transforms');
const protocol = require('./cross-provider-fallback');
const wire = require('./wire-api-compat');
const codex = require('./codex-compat');

const options = {
  compatibilityProvider: 'copilot',
  protocolTranslation: { kind: 'anthropic_to_chat', originProvider: 'copilot' },
  wireApiCompatibility: { direction: 'responses_to_chat' },
  codexCompatibility: { customTools: {} },
};

beforeEach(() => jest.resetAllMocks());

test('selects SSE transforms in protocol, wire API, then Codex order', () => {
  const protocolTransforms = [{ name: 'protocol-1' }, { name: 'protocol-2' }];
  const wireTransform = { name: 'wire' };
  const codexTransform = { name: 'codex' };
  protocol.createProtocolSseTransforms.mockReturnValue(protocolTransforms);
  wire.createWireApiSseTransform.mockReturnValue(wireTransform);
  codex.createCodexCompatibleSseTransform.mockReturnValue(codexTransform);

  expect(selectCompatibilityTransforms({ ...options, isStreaming: true, isJson: false }))
    .toEqual([...protocolTransforms, wireTransform, codexTransform]);
  expect(protocol.createProtocolSseTransforms).toHaveBeenCalledWith(options.protocolTranslation);
  expect(wire.createWireApiSseTransform).toHaveBeenCalledWith(options.wireApiCompatibility);
  expect(codex.createCodexCompatibleSseTransform).toHaveBeenCalledWith(options.codexCompatibility, 'copilot');
});

test.each([[false, false], [true, false], [false, true], [true, true]])(
  'omits unavailable SSE transforms (wire: %s, Codex: %s)', (hasWire, hasCodex) => {
    protocol.createProtocolSseTransforms.mockReturnValue([]);
    const wireTransform = { name: 'wire' };
    const codexTransform = { name: 'codex' };
    wire.createWireApiSseTransform.mockReturnValue(hasWire ? wireTransform : null);
    codex.createCodexCompatibleSseTransform.mockReturnValue(hasCodex ? codexTransform : null);
    expect(selectCompatibilityTransforms({ ...options, isStreaming: true }))
      .toEqual([...(hasWire ? [wireTransform] : []), ...(hasCodex ? [codexTransform] : [])]);
  },
);

test.each([false, true])('selects JSON transforms in order (also marked streaming: %s)', isStreaming => {
  const body = Buffer.from('original');
  const protocolBody = Buffer.from('protocol');
  const codexBody = Buffer.from('codex');
  protocol.transformProtocolResponseBody.mockReturnValue(protocolBody);
  wire.transformWireApiResponseBody.mockReturnValue(null);
  codex.transformCodexCompatibleResponseBody.mockReturnValue(codexBody);

  const transforms = selectCompatibilityTransforms({ ...options, isJson: true, isStreaming });
  expect(transforms).toHaveLength(3);
  expect(transforms.reduce((outgoing, transform) => transform(outgoing) || outgoing, body)).toBe(codexBody);
  expect(protocol.transformProtocolResponseBody).toHaveBeenCalledWith(body, options.protocolTranslation);
  expect(wire.transformWireApiResponseBody).toHaveBeenCalledWith(protocolBody, options.wireApiCompatibility);
  expect(codex.transformCodexCompatibleResponseBody)
    .toHaveBeenCalledWith(protocolBody, options.codexCompatibility, 'copilot');
  expect(protocol.createProtocolSseTransforms).not.toHaveBeenCalled();
});

test('uses the originating provider for JSON compatibility, not the serving provider', () => {
  const transforms = selectCompatibilityTransforms({
    ...options, compatibilityProvider: 'openai', isJson: true,
  });
  const body = Buffer.from('{}');
  transforms[2](body);
  expect(codex.transformCodexCompatibleResponseBody).toHaveBeenCalledWith(body, options.codexCompatibility, 'openai');
});

test('does not select transforms for other content types', () => {
  expect(selectCompatibilityTransforms({ ...options, isStreaming: false, isJson: false })).toEqual([]);
  expect(protocol.createProtocolSseTransforms).not.toHaveBeenCalled();
});
