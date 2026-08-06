import * as net from 'net';
import * as path from 'path';
import {
  CANONICAL_ERROR,
  CANONICAL_OK,
  CAPABILITY,
  createIngressConformanceHarness,
  PROBE_CAPABILITY,
  SCHEMA,
  stableResponse,
} from '../test-helpers/ingress-conformance-test-harness';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const { MAX_CONNECTIONS } = require(
  path.join(brokerDir, 'server.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-query ingress conformance', () => {
  const harness = createIngressConformanceHarness({
    brokerDir,
    socketRootPrefix: 'awf-ingress-test-',
    requestHeaders: {
      'x-awf-query-version': '2',
      'x-awf-repo': 'octo/private',
      'x-awf-schema-b64': SCHEMA,
    },
    defaultBody: 'print(True)',
  });

  beforeEach(async () => {
    await harness.start();
  });

  afterEach(async () => {
    await harness.stop();
  });

  const { audit, request, tcpRequest, unixRequest } = harness;

  it('returns byte-identical status, headers, and canonical result bytes', async () => {
    await harness.expectCanonicalTransportParity();
  });

  it('collapses missing, wrong, and duplicated authentication to canonical failure bytes', async () => {
    const missing = request({ host: '127.0.0.1', port: harness.tcpPort });
    const wrong = tcpRequest(undefined, 'c'.repeat(64));
    const duplicated = request({
      host: '127.0.0.1',
      port: harness.tcpPort,
      headers: { 'x-awf-capability': [CAPABILITY, CAPABILITY] },
    });
    const responses = await Promise.all([missing, wrong, duplicated]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toBe(CANONICAL_ERROR);
    }
    expect(harness.handled).toHaveLength(0);
  });

  it('uses a one-shot probe capability without launching or consuming a query request', async () => {
    const before = harness.handled.length;
    const first = await tcpRequest('', PROBE_CAPABILITY);
    const second = await tcpRequest('', PROBE_CAPABILITY);
    expect(first.body).toBe(CANONICAL_ERROR);
    expect(second.body).toBe(CANONICAL_ERROR);
    expect(harness.handled.length).toBe(before);
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

  it('does not dispatch broker work for a request that arrives on an over-limit socket', async () => {
    const holders = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () => new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: harness.tcpPort }, () => resolve(socket));
      socket.on('error', reject);
    })));

    try {
      const rawResponse = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: harness.tcpPort }, () => {
          socket.write([
            'POST /query HTTP/1.1',
            'Host: 127.0.0.1',
            `X-AWF-Capability: ${CAPABILITY}`,
            'Content-Type: application/octet-stream',
            'X-AWF-Query-Version: 2',
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
      expect(harness.handled).toHaveLength(0);
      expect(audit.failure).toHaveBeenCalledWith('transport', 'connection-limit');
    } finally {
      for (const socket of holders) socket.destroy();
    }
  });
});
