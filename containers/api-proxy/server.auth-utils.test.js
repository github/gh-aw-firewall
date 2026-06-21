const { shouldStripHeader } = require('./proxy-utils');
const { sanitizeNullToolCallTypes } = require('./body-transform');

describe('shouldStripHeader', () => {
  it('should strip authorization header', () => {
    expect(shouldStripHeader('authorization')).toBe(true);
    expect(shouldStripHeader('Authorization')).toBe(true);
  });

  it('should strip x-api-key header', () => {
    expect(shouldStripHeader('x-api-key')).toBe(true);
    expect(shouldStripHeader('X-Api-Key')).toBe(true);
  });

  it('should strip x-goog-api-key header (Gemini placeholder must be stripped)', () => {
    expect(shouldStripHeader('x-goog-api-key')).toBe(true);
    expect(shouldStripHeader('X-Goog-Api-Key')).toBe(true);
  });

  it('should strip proxy-authorization header', () => {
    expect(shouldStripHeader('proxy-authorization')).toBe(true);
  });

  it('should strip x-forwarded-* headers', () => {
    expect(shouldStripHeader('x-forwarded-for')).toBe(true);
    expect(shouldStripHeader('x-forwarded-host')).toBe(true);
  });

  it('should not strip content-type header', () => {
    expect(shouldStripHeader('content-type')).toBe(false);
  });

  it('should not strip anthropic-version header', () => {
    expect(shouldStripHeader('anthropic-version')).toBe(false);
  });
});

describe('sanitizeNullToolCallTypes (via copilot body transform)', () => {
  it('normalizes null tool_call type to "function" in outgoing message history', () => {
    const input = Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: null,
              function: { name: 'edit', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
      ],
    }));

    const result = sanitizeNullToolCallTypes(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.messages[0].tool_calls[0].type).toBe('function');
  });

  it('returns null when no tool_call type normalization is needed', () => {
    const input = Buffer.from(JSON.stringify({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'edit', arguments: '{}' },
            },
          ],
        },
      ],
    }));

    expect(sanitizeNullToolCallTypes(input)).toBeNull();
  });
});
