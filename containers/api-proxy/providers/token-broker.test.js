'use strict';

const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');
const { createTokenBrokerProvider, isTokenBrokerEnabled } = require('./token-broker');

const START = Date.parse('2026-10-30T17:00:00Z');
const ENDPOINT = 'https://broker.example.test/exchange?purpose=inference';
const ENV = {
  AWF_COPILOT_TOKEN_BROKER: 'true',
  GH_AW_TOKEN_BROKER_URL: ENDPOINT,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token?job=verified',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-bootstrap',
  GITHUB_REPOSITORY_ID: '123',
  GITHUB_REPOSITORY_OWNER_ID: '456',
  GITHUB_RUN_ID: '789',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_JOB: 'agent',
};
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function response(value, statusCode = 200, headers = HEADERS) {
  return { statusCode, headers, body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) };
}

function jwt(audience = ENDPOINT, exp = START / 1000 + 600) {
  return ['testheader', Buffer.from(JSON.stringify({ exp, aud: audience })).toString('base64url'), 'testsignature'].join('.');
}

function harness(env = ENV) {
  let time = START;
  let serial = 0;
  const request = jest.fn(async ({ method }) => method === 'POST'
    ? response({ token: `opaque-${++serial}`, expires_at: new Date(time + 60000).toISOString() })
    : response({ value: jwt(env.GH_AW_TOKEN_BROKER_URL, time / 1000 + 600) }));
  return { request, provider: createTokenBrokerProvider(env, { now: () => time, request }), setTime: value => { time = value; } };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('URL alone and non-boolean markers do not opt in', () => {
  for (const marker of [undefined, '', '1', 'false', 'TRUE', true]) {
    expect(isTokenBrokerEnabled({ GH_AW_TOKEN_BROKER_URL: ENDPOINT, AWF_COPILOT_TOKEN_BROKER: marker })).toBe(false);
  }
  expect(isTokenBrokerEnabled(ENV)).toBe(true);
});

test.each([
  undefined, '', 'http://broker.test', 'https://user@broker.test', 'https://@broker.test',
  'https://broker.test/#fragment', 'https://broker.test/#', ' https://broker.test', 'https://broker.test\\evil',
])('rejects invalid endpoint %s without network activity', endpoint => {
  const request = jest.fn();
  expect(() => createTokenBrokerProvider({ ...ENV, GH_AW_TOKEN_BROKER_URL: endpoint }, { request }))
    .toThrow('Token broker configuration is invalid.');
  expect(request).not.toHaveBeenCalled();
});

test.each(['GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB'])(
  'requires consuming execution context %s', key => {
    expect(() => createTokenBrokerProvider({ ...ENV, [key]: '' })).toThrow('Token broker configuration is invalid.');
  }
);

test('uses the unnormalized endpoint as complete POST URL and exact OIDC audience', async () => {
  const endpoint = 'https://BROKER.example.test:443/a/../exchange?x=%2f';
  const { provider, request } = harness({ ...ENV, GH_AW_TOKEN_BROKER_URL: endpoint });
  await provider.getToken();
  const oidc = request.mock.calls[0][0];
  expect(new URL(oidc.url).searchParams.get('audience')).toBe(endpoint);
  expect(oidc.headers.Authorization).toBe(['Bearer', ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN].join(' '));
  const exchange = request.mock.calls[1][0];
  expect(exchange.url).toBe(endpoint);
  expect(JSON.parse(exchange.body)).toEqual({ token_type: 'copilot-request', provider: 'github', oidc_token: jwt(endpoint) });
  expect(exchange.body).not.toContain(ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  expect(exchange.headers['Cache-Control']).toBe('no-store');
});

test('renews at exactly 30 seconds and coalesces concurrent same-context requests', async () => {
  const { provider, request, setTime } = harness();
  expect(await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()])).toEqual(['opaque-1', 'opaque-1', 'opaque-1']);
  expect(request).toHaveBeenCalledTimes(2);
  setTime(START + 29999);
  expect(await provider.getToken()).toBe('opaque-1');
  setTime(START + 30000);
  expect(provider.hasToken()).toBe(false);
  expect(await Promise.all([provider.getToken(), provider.getToken()])).toEqual(['opaque-2', 'opaque-2']);
  expect(request).toHaveBeenCalledTimes(4);
});

test.each(['GH_AW_TOKEN_BROKER_URL', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_JOB', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])(
  'does not share caches or pending requests across %s contexts', async key => {
    const first = harness();
    const second = harness({ ...ENV, [key]: key === 'GH_AW_TOKEN_BROKER_URL' ? 'https://other.example.test/exchange' : 'other' });
    await Promise.all([first.provider.getToken(), second.provider.getToken()]);
    expect(first.request).toHaveBeenCalledTimes(2);
    expect(second.request).toHaveBeenCalledTimes(2);
  }
);

test('retains an immutable context snapshot, never accepting agent request context', async () => {
  const env = { ...ENV };
  const test = harness(env);
  env.GH_AW_TOKEN_BROKER_URL = 'https://attacker.example.test';
  // The transport fixture uses a fixed valid identity for the original snapshot.
  test.request.mockImplementation(async ({ method }) => method === 'POST'
    ? response({ token: 'x', expires_at: '2026-10-30T17:01:00Z' })
    : response({ value: jwt() }));
  expect(await test.provider.getToken()).toBe('x');
  expect(test.request.mock.calls[1][0].url).toBe(ENDPOINT);
});

test.each([
  [401, 'UNAUTHORIZED'], [403, 'UNAUTHORIZED'], [400, 'UNSUPPORTED'], [404, 'UNSUPPORTED'],
  [422, 'UNSUPPORTED'], [501, 'UNSUPPORTED'], [302, 'UNAVAILABLE'], [307, 'UNAVAILABLE'],
  [429, 'UNAVAILABLE'], [503, 'UNAVAILABLE'],
])('classifies HTTP %i without exposing broker bodies or retrying', async (status, kind) => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response('secret error response', status));
  await expect(provider.getToken()).rejects.toMatchObject({ code: `ERR_TOKEN_BROKER_${kind}` });
  expect(request).toHaveBeenCalledTimes(2);
  expect(provider.hasToken()).toBe(false);
});

test.each([
  '{}', '[]', '{', '{"token":"secret","token":"secret","expires_at":"2026-10-30T18:00:00Z"}',
  '{"token":"secret","token":"secret"}',
  '{"token":"secret","expires_at":"2026-10-30T18:00:00Z","endpoint":"https://attacker.test"}',
  '{"token":123,"expires_at":"2026-10-30T18:00:00Z"}',
  '{"token":"","expires_at":"2026-10-30T18:00:00Z"}',
  '{"token":"space secret","expires_at":"2026-10-30T18:00:00Z"}',
  '{"token":"line\\nsecret","expires_at":"2026-10-30T18:00:00Z"}',
  '{"token":"é","expires_at":"2026-10-30T18:00:00Z"}',
  ' '.repeat(65537),
])('rejects malformed success fixture %#', async body => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response(body));
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE' });
});

test.each([
  '2026-02-29T18:00:00Z', '2026-04-31T18:00:00Z', '2026-10-30T24:00:00Z',
  '2026-10-30T18:60:00Z', '2026-10-30T18:00:60Z', '2026-10-30T18:00:00+24:00',
  '2026-10-30T18:00:00+00:60', '2026-10-30', 'tomorrow',
  '2026-10-30T17:00:30Z', '2026-10-30T17:00:29.999Z',
])('rejects invalid or near-expiry expiration %s', async expires_at => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response({ token: 'x', expires_at }));
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE' });
});

test.each(['2026-10-30t17:01:00.001z', '2026-10-31T17:01:00+23:59', '2026-10-30T17:01:00-23:59'])(
  'accepts restricted RFC3339 expiration %s and opaque one-character credential', async expires_at => {
    const { provider, request } = harness();
    request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response({ token: 'x', expires_at }));
    expect(await provider.getToken()).toBe('x');
  }
);

test.each([
  { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  { 'content-type': 'application/json' },
  { ...HEADERS, 'content-encoding': 'gzip' },
])('requires JSON, no-store and uncompressed bounded response', async headers => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response({ token: 'x', expires_at: '2026-10-30T18:00:00Z' }, 200, headers));
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE' });
});

test('rejects invalid UTF-8 rather than replacing invalid bytes', async () => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce({
    statusCode: 200, headers: HEADERS, body: Buffer.from([0xff]),
  });
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE' });
});

test('accepts a success body at exactly 65,536 bytes without token-length assumptions', async () => {
  const { provider, request } = harness();
  const prefix = '{"token":"';
  const suffix = '","expires_at":"2026-10-30T18:00:00Z"}';
  const token = 'x'.repeat(65536 - prefix.length - suffix.length);
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(response(prefix + token + suffix));
  expect(await provider.getToken()).toBe(token);
});

test('escaped duplicate keys cannot evade strict unique-member validation', async () => {
  const { provider, request } = harness();
  request.mockResolvedValueOnce(response({ value: jwt() })).mockResolvedValueOnce(
    response('{"token":"x","\\u0074oken":"y","expires_at":"2026-10-30T18:00:00Z"}')
  );
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE' });
});

test.each([
  response('sensitive redirect', 302), response({ value: 'not-a-jwt' }),
  response({ value: jwt('wrong-audience') }), response({ value: jwt(ENDPOINT, START / 1000) }),
  response(' '.repeat(65537)),
])('OIDC failure never sends an exchange or leaks data %#', async oidcResponse => {
  const { provider, request } = harness();
  request.mockResolvedValue(oidcResponse);
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_OIDC' });
  expect(request).toHaveBeenCalledTimes(1);
});

test('renewal outage discards the near-expiry token with no retry or fallback', async () => {
  const { provider, request, setTime } = harness();
  await provider.getToken();
  setTime(START + 30000);
  request.mockRejectedValue(new Error('sensitive transport exception'));
  await expect(provider.getToken()).rejects.toThrow('Token broker identity acquisition failed.');
  expect(provider.hasToken()).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

test('total deadline includes OIDC and exchange and aborts stalled work', async () => {
  jest.useFakeTimers();
  const { provider, request } = harness();
  request.mockImplementationOnce(() => new Promise(resolve => {
    setTimeout(() => resolve(response({ value: jwt() })), 9000);
  })).mockImplementationOnce(() => new Promise(() => {}));
  const pending = provider.getToken();
  const assertion = expect(pending).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_UNAVAILABLE' });
  await jest.advanceTimersByTimeAsync(9999);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][0].signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await assertion;
  expect(request.mock.calls[1][0].signal.aborted).toBe(true);
  expect(provider.hasToken()).toBe(false);
});

test('shutdown cancels pending work, clears cache and prevents subsequent exchanges', async () => {
  const { provider, request } = harness();
  request.mockImplementation(() => new Promise(() => {}));
  const pending = provider.getToken();
  const assertion = expect(pending).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_UNAVAILABLE' });
  provider.shutdown();
  await assertion;
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_UNAVAILABLE' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0].signal.aborted).toBe(true);
});

test('late OIDC completion after timeout cannot start exchange or populate cache', async () => {
  jest.useFakeTimers();
  const { provider, request } = harness();
  let complete;
  request.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const assertion = expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_UNAVAILABLE' });
  await jest.advanceTimersByTimeAsync(10000);
  await assertion;
  complete(response({ value: jwt() }));
  await jest.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(1);
  expect(provider.hasToken()).toBe(false);
});

test('default HTTPS transport bounds responses and destroys oversized work', async () => {
  const req = new EventEmitter();
  req.destroy = jest.fn();
  req.end = jest.fn();
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = HEADERS;
  res.destroy = jest.fn();
  jest.spyOn(https, 'request').mockImplementation((_url, options, onResponse) => {
    expect(options.headers['Accept-Encoding']).toBe('identity');
    queueMicrotask(() => {
      onResponse(res);
      res.emit('data', Buffer.alloc(65537));
    });
    return req;
  });
  const provider = createTokenBrokerProvider(ENV, { now: () => START });
  await expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_OIDC' });
  expect(req.destroy).toHaveBeenCalled();
  expect(res.destroy).toHaveBeenCalled();
});

test('deadline closes a real proxy socket stalled during CONNECT negotiation', async () => {
  let socket;
  let connected;
  let closed;
  const connectReady = new Promise(resolve => { connected = resolve; });
  const server = net.createServer(client => {
    socket = client;
    closed = new Promise(resolve => client.once('close', resolve));
    client.once('data', connected);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createTokenBrokerProvider({
    ...ENV, HTTPS_PROXY: `http://127.0.0.1:${server.address().port}`,
  }, { now: () => START });
  try {
    jest.useFakeTimers();
    const assertion = expect(provider.getToken()).rejects.toMatchObject({ code: 'ERR_TOKEN_BROKER_UNAVAILABLE' });
    await connectReady;
    await jest.advanceTimersByTimeAsync(10000);
    await assertion;
    jest.useRealTimers();
    await closed;
    expect(socket.destroyed).toBe(true);
  } finally {
    jest.useRealTimers();
    provider.shutdown();
    socket?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
