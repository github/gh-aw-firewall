const { isValidRequestId, buildRequestHeaders } = require('./request-headers');

describe('request-headers', () => {
  test('isValidRequestId enforces expected constraints', () => {
    expect(isValidRequestId('req-123.ABC')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('bad value')).toBe(false);
    expect(isValidRequestId('a'.repeat(129))).toBe(false);
  });

  test('buildRequestHeaders strips sensitive inbound headers and injects auth/request id', () => {
    const req = {
      headers: {
        host: 'example.com',
        authorization: '******',
        'x-forwarded-for': '1.2.3.4',
        'x-custom': 'keep-me',
      },
    };
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, req, {
      injectHeaders: { authorization: '******' },
      provider: 'openai',
      targetHost: 'api.openai.com',
      requestId: 'req-1',
    });

    expect(headers.host).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers.authorization).toBe('******');
    expect(headers['x-custom']).toBe('keep-me');
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('buildRequestHeaders applies copilot initiator and content length rewrite', () => {
    const req = {
      headers: {
        'x-custom': 'keep-me',
        'transfer-encoding': 'chunked',
      },
    };
    const body = Buffer.from('rewritten');
    const headers = buildRequestHeaders(body, 1, req, {
      injectHeaders: { authorization: '******' },
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-2',
    });

    expect(headers['x-initiator']).toBe('agent');
    expect(headers['content-length']).toBe(String(body.length));
    expect(headers['transfer-encoding']).toBeUndefined();
  });
});
