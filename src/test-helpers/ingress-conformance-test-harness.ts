import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

export const CAPABILITY = 'a'.repeat(64);
export const PROBE_CAPABILITY = 'b'.repeat(64);
export const CANONICAL_ERROR = '{"status":"error"}';
export const CANONICAL_OK = '{"status":"ok","result":true}';
export const SCHEMA = Buffer.from('{"type":"boolean"}').toString('base64url');

interface Response {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface BrokerServerModule {
  createServer: (options: object) => http.Server;
  createTcpServer: (options: object) => http.Server;
  listenOnSocket: (server: http.Server, options: object, audit: object) => Promise<void>;
  listenOnTcp: (server: http.Server, options: object) => Promise<void>;
}

interface IngressConformanceHarnessOptions {
  brokerDir: string;
  socketRootPrefix: string;
  requestHeaders: http.OutgoingHttpHeaders;
  defaultBody: string;
}

export function stableResponse(response: Response) {
  return {
    status: response.status,
    body: response.body,
    contentType: response.headers['content-type'],
    cacheControl: response.headers['cache-control'],
    contentLength: response.headers['content-length'],
  };
}

export function createIngressConformanceHarness(options: IngressConformanceHarnessOptions) {
  /* eslint-disable @typescript-eslint/no-require-imports, security/detect-non-literal-require */
  const server: BrokerServerModule = require(path.join(options.brokerDir, 'server.js'));
  /* eslint-enable @typescript-eslint/no-require-imports, security/detect-non-literal-require */
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

  function request(requestOptions: http.RequestOptions, body = options.defaultBody): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: 'POST',
        path: '/query',
        ...requestOptions,
        headers: {
          'content-type': 'application/octet-stream',
          ...options.requestHeaders,
          ...requestOptions.headers,
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

  return {
    audit,
    get handled() {
      return handled;
    },
    get tcpPort() {
      return tcpPort;
    },
    async start() {
      root = fs.mkdtempSync(path.join(os.tmpdir(), options.socketRootPrefix));
      socketPath = path.join(root, 'broker.sock');
      handled = [];
      const broker = {
        handle: (incoming: unknown, respond: (body: string) => void) => {
          handled.push(incoming);
          respond(incoming === undefined ? CANONICAL_ERROR : CANONICAL_OK);
          return Promise.resolve();
        },
      };
      unixServer = server.createServer({ broker, audit });
      tcpServer = server.createTcpServer({
        broker,
        audit,
        capabilities: { query: CAPABILITY, probe: PROBE_CAPABILITY },
      });
      await server.listenOnSocket(unixServer, {
        socketPath,
        socketDir: root,
        socketUid: process.getuid?.() ?? 0,
        socketGid: process.getgid?.() ?? 0,
      }, audit);
      await server.listenOnTcp(tcpServer, { tcpPort: 0 });
      tcpPort = (tcpServer.address() as AddressInfo).port;
    },
    async stop() {
      await Promise.all([
        new Promise<void>((resolve) => unixServer.close(() => resolve())),
        new Promise<void>((resolve) => tcpServer.close(() => resolve())),
      ]);
      fs.rmSync(root, { recursive: true, force: true });
      jest.clearAllMocks();
    },
    request,
    unixRequest: (body?: string) => request({ socketPath }, body),
    tcpRequest: (body?: string, capability = CAPABILITY) => request({
      host: '127.0.0.1',
      port: tcpPort,
      headers: { 'x-awf-capability': capability },
    }, body),
    async expectCanonicalTransportParity() {
      const [unix, tcp] = await Promise.all([
        request({ socketPath }),
        request({
          host: '127.0.0.1',
          port: tcpPort,
          headers: { 'x-awf-capability': CAPABILITY },
        }),
      ]);
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
    },
  };
}
