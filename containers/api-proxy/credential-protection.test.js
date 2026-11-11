'use strict';

const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  rememberInjectedCredentials, createCredentialTransform, redactCredentialText,
  redactCredentialError, protectResponseHeaders,
} = require('./credential-protection');
const { createWebSocketCredentialTransform } = require('./credential-websocket');
const { providerKeyHeaders, withCopilotIntegration } = require('./providers/auth-headers');

async function collect(transform, chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), transform, new Writable({
    write(chunk, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

const HANDSHAKE = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');

function frame(opcode, payload, fin = true) {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = header.length === 2 ? bytes.length : header.length === 4 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(bytes.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(bytes.length), 2);
  return Buffer.concat([header, bytes]);
}

describe('request-scoped credential protection', () => {
  it('masks every byte split, repeated values and a trailing full credential', async () => {
    const req = {};
    const secret = 'MiXeD-DUMMY-Key';
    rememberInjectedCredentials(req, { Authorization: `Bearer ${secret}` });
    const body = Buffer.from(`before ${secret} ${secret.toLowerCase()} ${secret}`);
    const expected = Buffer.from(`before ${'*'.repeat(secret.length)} ${secret.toLowerCase()} ${'*'.repeat(secret.length)}`);
    for (let split = 0; split <= body.length; split++) {
      expect(await collect(createCredentialTransform(req), [body.subarray(0, split), body.subarray(split)])).toEqual(expected);
    }
    expect(await collect(createCredentialTransform(req), [...body].map(byte => Buffer.from([byte])))).toEqual(expected);
  });

  it('does not buffer ordinary model output until end', () => {
    const req = {};
    rememberInjectedCredentials(req, { 'x-api-key': 'SECRET-DUMMY' });
    const transform = createCredentialTransform(req);
    let bytes = 0;
    transform.on('data', chunk => { bytes += chunk.length; });
    const chunk = Buffer.alloc(65536, 0x78);
    for (let i = 0; i < 32; i++) {
      transform.write(chunk);
      expect(bytes).toBe((i + 1) * chunk.length);
    }
    transform.end();
  });

  it('handles overlapping credentials, escaped values and UTF-8 bytes at every split', async () => {
    const req = {};
    const secret = 'JSON-"DUMMY-\\Credential';
    const escaped = JSON.stringify(secret).slice(1, -1);
    rememberInjectedCredentials(req, { 'x-api-key': secret, 'x-other-key': 'DUMMY' });
    const body = Buffer.from(`café ${escaped} DUMMY ${secret}`);
    const expected = Buffer.from(`café ${'*'.repeat(Buffer.byteLength(escaped))} ***** ${'*'.repeat(Buffer.byteLength(secret))}`);
    for (let split = 0; split <= body.length; split++) {
      expect(await collect(createCredentialTransform(req), [body.subarray(0, split), body.subarray(split)])).toEqual(expected);
    }
    expect((await collect(createCredentialTransform(req), ['JSON-"DUMMY'])).toString()).toBe('JSON-"*****');
  });

  it('keeps requests isolated and updates cached patterns after credential renewal', async () => {
    const first = {};
    const second = {};
    rememberInjectedCredentials(first, { 'x-api-key': 'FIRST-DUMMY' });
    rememberInjectedCredentials(second, { 'x-api-key': 'SECOND-DUMMY' });
    expect(redactCredentialText(first, 'FIRST-DUMMY SECOND-DUMMY')).toBe('*********** SECOND-DUMMY');
    expect(redactCredentialText(second, 'FIRST-DUMMY SECOND-DUMMY')).toBe('FIRST-DUMMY ************');
    rememberInjectedCredentials(first, { Authorization: 'token RENEWED-DUMMY' });
    expect((await collect(createCredentialTransform(first), ['RENEWED-', 'DUMMY FIRST-DUMMY'])).toString())
      .toBe('************* ***********');
  });

  it('ignores empty and whitespace-only extracted authorization tokens', async () => {
    const req = {};
    rememberInjectedCredentials(req, { Authorization: 'Bearer       ' });
    expect(await collect(createCredentialTransform(req), ['ordinary response'])).toEqual(Buffer.from('ordinary response'));
  });

  it('tracks explicitly marked custom auth headers even when their names also denote metadata', () => {
    const req = {};
    rememberInjectedCredentials(req, withCopilotIntegration(
      providerKeyHeaders('Anthropic-Beta', 'CUSTOM-DUMMY'), 'agentic-workflows',
    ));
    expect(redactCredentialText(req, 'CUSTOM-DUMMY agentic-workflows')).toBe('************ agentic-workflows');
  });

  it('does not choose masking bytes that recreate a credential', async () => {
    const req = {};
    rememberInjectedCredentials(req, { 'x-api-key': '***' });
    expect((await collect(createCredentialTransform(req), ['prefix **', '* suffix'])).toString()).toBe('prefix ### suffix');
  });

  it('protects AWS access keys, session tokens and signatures actually sent on the wire', () => {
    const req = {};
    rememberInjectedCredentials(req, {
      Authorization: 'AWS4-HMAC-SHA256 Credential=DUMMYACCESS/20261111/region/service/aws4_request, SignedHeaders=host, Signature=DUMMYSIGNATURE',
      'x-amz-security-token': 'DUMMYSESSION',
    });
    expect(redactCredentialText(req, 'DUMMYACCESS DUMMYSIGNATURE DUMMYSESSION')).toBe('*********** ************** ************');
  });

  it('protects array-valued headers and exception messages/stacks before serialization', () => {
    const req = {};
    rememberInjectedCredentials(req, { 'x-api-key': 'ERROR-DUMMY' });
    expect(protectResponseHeaders(req, { 'x-diagnostic': ['ERROR-DUMMY', 'ok'] }))
      .toEqual({ 'x-diagnostic': ['***********', 'ok'] });
    const error = Object.assign(new Error('upstream echoed ERROR-DUMMY'), { code: 'ERR_LOCAL' });
    const safe = redactCredentialError(req, error);
    expect(safe.message).toBe('upstream echoed ***********');
    expect(safe.stack).not.toContain('ERROR-DUMMY');
    expect(safe.code).toBe('ERR_LOCAL');
    expect(error.message).toBe('upstream echoed ERROR-DUMMY');
  });
});

describe('bounded WebSocket credential protection', () => {
  function context() {
    const req = {};
    rememberInjectedCredentials(req, { 'x-api-key': 'SECRET-DUMMY' });
    return req;
  }

  it('preserves ordinary frames, extended lengths, UTF-8 bytes and control frames exactly', async () => {
    const wire = Buffer.concat([
      HANDSHAKE, frame(1, 'ordinary output'), frame(9, 'ping'), frame(10, 'pong'),
      frame(2, Buffer.alloc(150, 0x78)), frame(1, Buffer.alloc(70000, 0x79)),
      frame(8, Buffer.from([0x03, 0xe8])),
    ]);
    const expected = Buffer.concat([
      HANDSHAKE, frame(1, 'ordinary output'), frame(10, 'pong'),
      frame(2, Buffer.alloc(150, 0x78)), frame(1, Buffer.alloc(70000, 0x79)),
      frame(8, Buffer.from([0x03, 0xe8])),
    ]);
    expect(await collect(createWebSocketCredentialTransform(context()), [wire])).toEqual(expected);
  });

  it('masks byte-split frames and credentials spanning continuations and interleaved pings', async () => {
    const wire = Buffer.concat([
      HANDSHAKE, frame(1, 'echo SECRET-', false), frame(9, 'ping'), frame(0, 'DUMMY'),
      frame(8, Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from('SECRET-DUMMY')])),
    ]);
    const expected = Buffer.concat([
      HANDSHAKE, frame(1, 'echo *******', false), frame(0, '*****'),
      frame(8, Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from('************')])),
    ]);
    expect(await collect(createWebSocketCredentialTransform(context()), [...wire].map(byte => Buffer.from([byte]))))
      .toEqual(expected);
  });

  it('masks non-ASCII credentials in raw UTF-8 upgrade headers', async () => {
    const req = {};
    const secret = 'clé-DUMMY';
    rememberInjectedCredentials(req, { authorization: secret });
    const handshake = Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nX-Diagnostic: ${secret}\r\n\r\n`,
    );
    const expected = Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nX-Diagnostic: ${'*'.repeat(Buffer.byteLength(secret))}\r\n\r\n`,
    );
    expect(await collect(createWebSocketCredentialTransform(req), [handshake])).toEqual(expected);
  });

  it('streams a multi-megabyte frame without buffering the model message', () => {
    const transform = createWebSocketCredentialTransform(context());
    let bytes = 0;
    transform.on('data', chunk => { bytes += chunk.length; });
    const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 32, 0, 0]);
    transform.write(Buffer.concat([HANDSHAKE, header]));
    const chunk = Buffer.alloc(65536, 0x78);
    for (let i = 0; i < 32; i++) {
      transform.write(chunk);
      expect(bytes).toBe(HANDSHAKE.length + header.length + (i + 1) * chunk.length);
    }
    transform.end();
  });

  it.each([
    ['compressed frame', Buffer.concat([HANDSHAKE, Buffer.from([0xc1, 0])]), 'Unsupported upstream WebSocket frame'],
    ['masked server frame', Buffer.concat([HANDSHAKE, Buffer.from([0x81, 0x80])]), 'Unsupported upstream WebSocket frame'],
    ['truncated frame', Buffer.concat([HANDSHAKE, Buffer.from([0x81, 4, 0x78])]), 'Truncated upstream WebSocket response'],
    ['oversized handshake', Buffer.alloc(16385, 0x78), 'Upstream WebSocket handshake limit exceeded'],
  ])('fails closed on %s', async (_label, wire, message) => {
    await expect(collect(createWebSocketCredentialTransform(context()), [wire])).rejects.toThrow(message);
  });

  it('handles many pings without blocking a fragmented credential prefix', async () => {
    const chunks = [
      HANDSHAKE, frame(1, 'SECRET-', false),
      ...Array.from({ length: 600 }, () => frame(9, Buffer.alloc(125, 0x78))),
      frame(0, 'DUMMY'),
    ];
    const expected = Buffer.concat([
      HANDSHAKE, frame(1, '*******', false), frame(0, '*****'),
    ]);
    expect(await collect(createWebSocketCredentialTransform(context()), chunks)).toEqual(expected);
  });
});
