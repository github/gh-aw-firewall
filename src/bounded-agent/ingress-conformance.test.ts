import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { createServer, createTcpServer, listenOnSocket, listenOnTcp, MAX_CONNECTIONS } = require(
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

function request(options: http.RequestOptions, body = 'is it true?'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      path: '/query',
      ...options,
      headers: {
        'content-type': 'application/octet-stream',
        'x-awf-agent-version': '1',
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

describe('bounded-agent ingress conformance', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-ingress-test-'));
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

  it('returns byte-identical canonical responses and strips the capability before framing', async () => {
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

  it('collapses missing, wrong, and duplicated capabilities to the same failure', async () => {
    const responses = await Promise.all([
      request({ host: '127.0.0.1', port: tcpPort }),
      tcpRequest(undefined, 'c'.repeat(64)),
      request({
        host: '127.0.0.1',
        port: tcpPort,
        headers: { 'x-awf-capability': [CAPABILITY, CAPABILITY] },
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toBe(CANONICAL_ERROR);
    }
    expect(handled).toHaveLength(0);
  });

  it('retires the one-shot probe without dispatching broker work', async () => {
    const first = await tcpRequest('', PROBE_CAPABILITY);
    const second = await tcpRequest('', PROBE_CAPABILITY);
    expect(first.body).toBe(CANONICAL_ERROR);
    expect(second.body).toBe(CANONICAL_ERROR);
    expect(handled).toHaveLength(0);
    expect(audit.lifecycle).toHaveBeenCalledTimes(1);
    expect(audit.lifecycle).toHaveBeenCalledWith('sbx-ingress-probe');
  });

  it('keeps oversized-body behavior identical across transports', async () => {
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const [unix, tcp] = await Promise.all([unixRequest(oversized), tcpRequest(oversized)]);
    expect(unix.body).toBe(CANONICAL_ERROR);
    expect(stableResponse(tcp)).toEqual(stableResponse(unix));
  });

  it('does not dispatch work for an over-limit connection', async () => {
    const holders = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () =>
      new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: tcpPort }, () => resolve(socket));
        socket.on('error', reject);
      })));
    try {
      const rawResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: tcpPort }, () => {
          socket.write([
            'POST /query HTTP/1.1',
            'Host: 127.0.0.1',
            `X-AWF-Capability: ${CAPABILITY}`,
            'Content-Type: application/octet-stream',
            'X-AWF-Agent-Version: 1',
            'X-AWF-Repo: octo/private',
            `X-AWF-Schema-B64: ${SCHEMA}`,
            'Content-Length: 0',
            '',
            '',
          ].join('\r\n'));
        });
        const chunks: Uint8Array[] = [];
        socket.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
      });
      expect(rawResponse).toContain(CANONICAL_ERROR);
      expect(handled).toHaveLength(0);
      expect(audit.failure).toHaveBeenCalledWith('transport', 'connection-limit');
    } finally {
      for (const socket of holders) socket.destroy();
    }
  });
});
