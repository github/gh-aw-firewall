const {
  parseModelNotSupportedFromBody,
  parseModelEndpointBlockedFromBody,
} = require('./upstream-error-classification');

describe('upstream-error-classification', () => {
  test.each([
    ['{"error":{"message":"The requested model is not supported"}}', true, false],
    ['THE REQUESTED MODEL IS NOT SUPPORTED', true, false],
    ['model "test" is not accessible via the /chat/completions endpoint', false, true],
    ['Model is NOT ACCESSIBLE VIA THE /responses ENDPOINT', false, true],
    ['The requested model is not supported and is not accessible via the /responses endpoint', true, true],
    ['{"error":{"message":"Invalid API key"}}', false, false],
    ['not accessible via the endpoint', false, false],
    ['', false, false],
  ])('classifies %j', (text, unsupported, endpointBlocked) => {
    const body = Buffer.from(text);
    expect(parseModelNotSupportedFromBody(body)).toBe(unsupported);
    expect(parseModelEndpointBlockedFromBody(body)).toBe(endpointBlocked);
  });
});
