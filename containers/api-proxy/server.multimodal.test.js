'use strict';

const http = require('http');
const { setupServerTestEnv, getStructuredLogs } = require('./test-helpers/server-mock-factories');

jest.mock('./otel', () => ({
  startRequestSpan: () => ({ setAttribute() {}, setAttributes() {}, addEvent() {} }),
  endSpan() {},
  endSpanError() {},
}));
jest.mock('./token-tracker', () => ({ trackTokenUsage() {}, trackWebSocketTokenUsage() {} }));
jest.mock('./token-persistence', () => ({
  auditTrack() {}, auditUpstreamErrorResponse() {}, auditEnclaveResponse() {},
}));

const MAX_BODY_SIZE = 10 * 1024 * 1024;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=';

function imageRequest(toolImage = PNG) {
  return Buffer.from(JSON.stringify({
    model: 'image-model',
    stream: true,
    input: [
      { role: 'user', content: [
        { type: 'input_text', text: 'Describe this private PNG: 🖼️' },
        { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
      ] },
      { type: 'function_call', name: 'view', call_id: 'private-call', arguments: '{"path":"private.png"}' },
      { type: 'function_call_output', call_id: 'private-call', output: [
        { type: 'input_text', text: 'Viewed image file successfully.' },
        { type: 'input_image', image_url: `data:image/png;base64,${toolImage}`, detail: 'auto' },
      ] },
    ],
  }, null, 2) + '\n');
}

describe.each(['copilot', 'openai'])('%s Responses multimodal passthrough', provider => {
  const originalHttpProxy = process.env.HTTP_PROXY;
  let proxyCore;
  let createProviderServer;
  let createCopilotAdapter;
  let createOpenAIAdapter;
  let clearRuntimeModels;
  let proxy;
  let upstream;
  let requests;
  let logs;

  setupServerTestEnv(() => {
    delete process.env.HTTP_PROXY;
    proxyCore = require('./proxy-request');
    ({ createProviderServer } = require('./server-factory'));
    ({ createCopilotAdapter } = require('./providers/copilot'));
    ({ createOpenAIAdapter } = require('./providers/openai'));
    ({ clearRuntimeModels } = require('./runtime-model-catalog'));
  });

  afterAll(() => {
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
  });

  async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }

  beforeEach(async () => {
    clearRuntimeModels();
    requests = [];
    logs = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ body: Buffer.concat(chunks), headers: req.headers, url: req.url });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"type":"response.completed","response":{"id":"local-response","output":[]}}\n\n');
      });
    });
    await listen(upstream);
    const target = `http://127.0.0.1:${upstream.address().port}`;
    const adapter = provider === 'copilot' ? createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'trusted-sidecar-placeholder',
      COPILOT_API_TARGET: target,
    }) : createOpenAIAdapter({
      OPENAI_API_KEY: 'trusted-sidecar-placeholder',
      OPENAI_API_TARGET: target,
    });
    proxy = createProviderServer(adapter, {
      handleManagementEndpoint: () => false,
      checkRateLimit: proxyCore.checkRateLimit,
      proxyRequest: proxyCore.proxyRequest,
      proxyWebSocket: proxyCore.proxyWebSocket,
    });
    await listen(proxy);
  });

  afterEach(async () => {
    for (const server of [proxy, upstream]) {
      if (!server) continue;
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    clearRuntimeModels();
    jest.restoreAllMocks();
  });

  function post(body, path = '/responses', chunked = false, server = proxy) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, method: 'POST', path,
        headers: {
          'content-type': 'application/json',
          authorization: ['Bearer', 'agent-placeholder'].join(' '),
          'x-request-id': 'image-test',
          ...(chunked ? {} : { 'content-length': body.length }),
        },
        timeout: 5000,
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Local multimodal proxy test timed out')));
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        req.write(body.subarray(offset, offset + 64 * 1024));
      }
      req.end();
    });
  }

  test.each(['/responses', '/v1/responses'])('forwards message/tool images byte-identically on %s', async path => {
    const body = imageRequest();
    const direct = await post(body, path, false, upstream);
    const [directRequest] = requests.splice(0);
    expect(direct.status).toBe(200);
    expect(directRequest.body).toEqual(body);
    expect(getStructuredLogs(logs, 'request_shape')).toEqual([]);
    expect((await post(body, path)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual(directRequest.body);
    expect(requests[0].body).toEqual(body);
    expect(requests[0].url).toBe(path);
    expect(Number(requests[0].headers['content-length'])).toBe(body.length);
    expect(requests[0].headers.authorization).toBe(['Bearer', 'trusted-sidecar-placeholder'].join(' '));
    const shapes = getStructuredLogs(logs, 'request_shape');
    expect(shapes.map(shape => shape.stage)).toEqual(['inbound', 'upstream']);
    for (const shape of shapes) {
      expect(shape).toMatchObject({
        level: 'debug', request_id: 'image-test', provider, body_bytes: body.length,
        input_item_types: { message: 1, function_call: 1, function_call_output: 1 },
        content_part_types: { input_text: 1, input_image: 1 },
        tool_output_part_types: { input_text: 1, input_image: 1 },
      });
    }
    expect(logs.mock.calls.map(([line]) => line).join(''))
      .not.toMatch(/private|Viewed image|iVBOR|trusted-sidecar-placeholder|agent-placeholder/);
  });

  test('reports a text-only view result without inventing image parts', async () => {
    const parsed = JSON.parse(imageRequest());
    parsed.input = [
      { type: 'function_call_output', call_id: 'private-call', output: 'Viewed image file successfully.' },
    ];
    const body = Buffer.from(JSON.stringify(parsed));
    expect((await post(body)).status).toBe(200);
    expect(requests[0].body).toEqual(body);
    for (const shape of getStructuredLogs(logs, 'request_shape')) {
      expect(shape.content_part_types).toEqual({});
      expect(shape.tool_output_part_types).toEqual({ text: 1 });
    }
  });

  test('preserves a chunked base64 body at exactly the 10 MiB limit', async () => {
    const image = imageRequest('AAAA'.repeat(Math.floor((MAX_BODY_SIZE - 2048) / 4)));
    const body = Buffer.concat([image, Buffer.alloc(MAX_BODY_SIZE - image.length, 0x20)]);
    expect((await post(body, '/responses', true)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.equals(body)).toBe(true);
    expect(requests[0].headers['content-length']).toBeUndefined();
    expect(requests[0].headers['transfer-encoding']).toBe('chunked');
  });

  test('rejects an oversized image body with 413 instead of forwarding truncated data', async () => {
    const image = imageRequest('AAAA'.repeat(Math.floor((MAX_BODY_SIZE - 2048) / 4)));
    const body = Buffer.concat([image, Buffer.alloc(MAX_BODY_SIZE + 1 - image.length, 0x20)]);
    const response = await post(body);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'Payload Too Large' });
    expect(requests).toHaveLength(0);
    expect(getStructuredLogs(logs, 'request_shape')).toEqual([]);
  });
});
