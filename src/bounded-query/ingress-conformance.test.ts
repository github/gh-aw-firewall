import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const { createServer, createTcpServer, listenOnSocket, listenOnTcp } = require(
  path.join(brokerDir, 'server.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

const CAPABILITY = 'a'.repeat(64);
const PROBE_CAPABILITY = 'b'.repeat(64);
const CANONICAL_ERROR = '{"status":"error"}';
const CANONICAL_OK = '{"status":"ok","result":true}';
const SCHEMA = Buffer.from('{"type":"boolean"}').toString('base64url');

interface Response {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function stableResponse(response: Response) {
  return {
    status: response.status,
    body: response.body,
    contentType: response.headers['content-type'],
    cacheControl: response.headers['cache-control'],
    contentLength: response.headers['content-length'],
  };
}

function request(options: http.RequestOptions, body = 'print(True)'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      path: '/query',
      ...options,
      headers: {
        'content-type': 'application/octet-stream',
        'x-awf-query-version': '2',
        'x-awf-repo': 'octo/private',
        'x-awf-schema-b64': SCHEMA,
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('bounded-query ingress conformance', () => {
  let root: string;
  let unixServer: http.Server;
  let tcpServer: http.Server;
  let socketPath: string;
  let tcpPort: number;
  let handled: unknown[];
  const audit = {
    failure: jest.fn(),
    lifecycle: jest.fn(),
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ingress-test-'));
    socketPath = path.join(root, 'broker.sock');
    handled = [];
    const broker = {
      handle: (incoming: unknown, respond: (body: string) => void) => {
        handled.push(incoming);
        respond(incoming === undefined ? CANONICAL_ERROR : CANONICAL_OK);
        return Promise.resolve();
      },
    };
    unixServer = createServer({ broker, audit });
    tcpServer = createTcpServer({
      broker,
      audit,
      capabilities: { query: CAPABILITY, probe: PROBE_CAPABILITY },
    });
    await listenOnSocket(unixServer, {
      socketPath,
      socketDir: root,
      socketUid: process.getuid?.() ?? 0,
      socketGid: process.getgid?.() ?? 0,
    }, audit);
    await listenOnTcp(tcpServer, { tcpPort: 0 });
    tcpPort = (tcpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await Promise.all([
      new Promise<void>((resolve) => unixServer.close(() => resolve())),
      new Promise<void>((resolve) => tcpServer.close(() => resolve())),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  const unixRequest = (body?: string) => request({ socketPath }, body);
  const tcpRequest = (body?: string, capability = CAPABILITY) => request({
    host: '127.0.0.1',
    port: tcpPort,
    headers: { 'x-awf-capability': capability },
  }, body);

  it('returns byte-identical status, headers, and canonical result bytes', async () => {
    const [unix, tcp] = await Promise.all([unixRequest(), tcpRequest()]);
    expect(stableResponse(tcp)).toEqual(stableResponse(unix));
    expect(stableResponse(tcp)).toEqual(expect.objectContaining({
      status: 200,
      body: CANONICAL_OK,
      contentType: 'application/json',
      cacheControl: 'no-store',
      contentLength: String(Buffer.byteLength(CANONICAL_OK)),
    }));
    expect(handled).toHaveLength(2);
    expect(handled[0]).toEqual(handled[1]);
    expect(handled[0]).not.toHaveProperty('capability');
  });

  it('collapses missing, wrong, and duplicated authentication to canonical failure bytes', async () => {
    const missing = request({ host: '127.0.0.1', port: tcpPort });
    const wrong = tcpRequest(undefined, 'c'.repeat(64));
    const duplicated = request({
      host: '127.0.0.1',
      port: tcpPort,
      headers: { 'x-awf-capability': [CAPABILITY, CAPABILITY] },
    });
    const responses = await Promise.all([missing, wrong, duplicated]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toBe(CANONICAL_ERROR);
    }
    expect(handled).toHaveLength(0);
  });

  it('uses a one-shot probe capability without launching or consuming a query request', async () => {
    const before = handled.length;
    const first = await tcpRequest('', PROBE_CAPABILITY);
    const second = await tcpRequest('', PROBE_CAPABILITY);
    expect(first.body).toBe(CANONICAL_ERROR);
    expect(second.body).toBe(CANONICAL_ERROR);
    expect(handled.length).toBe(before);
    expect(audit.lifecycle).toHaveBeenCalledWith('sbx-ingress-probe');
  });

  it('keeps oversized and parallel request behavior identical across transports', async () => {
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const [unixOversized, tcpOversized] = await Promise.all([
      unixRequest(oversized),
      tcpRequest(oversized),
    ]);
    expect(unixOversized.body).toBe(CANONICAL_ERROR);
    expect(stableResponse(tcpOversized)).toEqual(stableResponse(unixOversized));

    const results = await Promise.all([
      unixRequest(),
      unixRequest(),
      tcpRequest(),
      tcpRequest(),
    ]);
    expect(results.map((result) => result.body)).toEqual(Array(4).fill(CANONICAL_OK));
  });
});
