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

/**
 * TCP ingress conformance tests for the bounded-agent broker, mirroring the
 * coverage bounded queries already have
 * (`src/bounded-query/ingress-conformance.test.ts`): missing/duplicate/wrong
 * capability rejection, one-shot probe retirement, capability-header
 * stripping before framing, byte-identical Unix/TCP canonical responses, body
 * size limits, and connection-limit behavior.
 *
 * Only `server.js`'s existing exports (`createServer`, `createTcpServer`,
 * `listenOnSocket`, `listenOnTcp`, `MAX_CONNECTIONS`) are used — no
 * production surface is widened for these tests.
 */

const CAPABILITY = 'a'.repeat(64);
const PROBE_CAPABILITY = 'b'.repeat(64);
const CANONICAL_ERROR = '{"status":"error"}';
const CANONICAL_OK = '{"status":"ok","result":true}';
const SCHEMA = Buffer.from('{"type":"boolean"}').toString('base64url');
const MAX_TASK_BYTES = 64 * 1024;

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

function request(options: http.RequestOptions, body = 'do the task'): Promise<Response> {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-ingress-test-'));
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

  it('returns byte-identical status, headers, and canonical result bytes across transports', async () => {
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
    expect(audit.failure).toHaveBeenCalledWith('transport', 'auth-rejected');
  });

  it('uses a one-shot probe capability without launching or consuming a request, then permanently retires it', async () => {
    const before = handled.length;
    const first = await tcpRequest('', PROBE_CAPABILITY);
    const second = await tcpRequest('', PROBE_CAPABILITY);
    expect(first.body).toBe(CANONICAL_ERROR);
    expect(second.body).toBe(CANONICAL_ERROR);
    expect(handled.length).toBe(before);
    expect(audit.lifecycle).toHaveBeenCalledWith('sbx-ingress-probe');
    expect(audit.lifecycle).toHaveBeenCalledTimes(1);
    // The second attempt with the same (now-retired) probe capability must be
    // rejected as an ordinary auth failure, not treated as another probe.
    expect(audit.failure).toHaveBeenCalledWith('transport', 'auth-rejected');
  });

  it('strips the capability header before handing the request to framing/broker logic', async () => {
    await tcpRequest();
    expect(handled).toHaveLength(1);
    expect(handled[0]).not.toHaveProperty('capability');
    expect(JSON.stringify(handled[0])).not.toContain(CAPABILITY);
  });

  it('keeps oversized and parallel request behavior identical across transports', async () => {
    const oversized = 'x'.repeat(MAX_TASK_BYTES + 1);
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

  it('accepts a task body exactly at the size limit and rejects one byte over it, identically on both transports', async () => {
    const atLimit = 'x'.repeat(MAX_TASK_BYTES);
    const overLimit = 'x'.repeat(MAX_TASK_BYTES + 1);
    const [unixAtLimit, tcpAtLimit] = await Promise.all([unixRequest(atLimit), tcpRequest(atLimit)]);
    expect(unixAtLimit.body).toBe(CANONICAL_OK);
    expect(tcpAtLimit.body).toBe(CANONICAL_OK);

    const [unixOverLimit, tcpOverLimit] = await Promise.all([
      unixRequest(overLimit),
      tcpRequest(overLimit),
    ]);
    expect(unixOverLimit.body).toBe(CANONICAL_ERROR);
    expect(tcpOverLimit.body).toBe(CANONICAL_ERROR);
  });

  it('does not dispatch broker work for a request that arrives on an over-limit socket', async () => {
    const holders = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () => new Promise<net.Socket>((resolve, reject) => {
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
