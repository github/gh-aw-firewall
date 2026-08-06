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
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const { MAX_CONNECTIONS } = require(
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

const MAX_TASK_BYTES = 64 * 1024;

describe('bounded-agent ingress conformance', () => {
  const harness = createIngressConformanceHarness({
    brokerDir,
    socketRootPrefix: 'awf-bounded-agent-ingress-test-',
    requestHeaders: {
      'x-awf-agent-version': '1',
      'x-awf-repo': 'octo/private',
      'x-awf-schema-b64': SCHEMA,
    },
    defaultBody: 'do the task',
  });

  beforeEach(async () => {
    await harness.start();
  });

  afterEach(async () => {
    await harness.stop();
  });

  const { audit, request, tcpRequest, unixRequest } = harness;

  it('returns byte-identical status, headers, and canonical result bytes across transports', async () => {
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
    expect(audit.failure).toHaveBeenCalledWith('transport', 'auth-rejected');
  });

  it('uses a one-shot probe capability without launching or consuming a request, then permanently retires it', async () => {
    const before = harness.handled.length;
    const first = await tcpRequest('', PROBE_CAPABILITY);
    const second = await tcpRequest('', PROBE_CAPABILITY);
    expect(first.body).toBe(CANONICAL_ERROR);
    expect(second.body).toBe(CANONICAL_ERROR);
    expect(harness.handled.length).toBe(before);
    expect(audit.lifecycle).toHaveBeenCalledWith('sbx-ingress-probe');
    expect(audit.lifecycle).toHaveBeenCalledTimes(1);
    // The second attempt with the same (now-retired) probe capability must be
    // rejected as an ordinary auth failure, not treated as another probe.
    expect(audit.failure).toHaveBeenCalledWith('transport', 'auth-rejected');
  });

  it('strips the capability header before handing the request to framing/broker logic', async () => {
    await tcpRequest();
    expect(harness.handled).toHaveLength(1);
    expect(harness.handled[0]).not.toHaveProperty('capability');
    expect(JSON.stringify(harness.handled[0])).not.toContain(CAPABILITY);
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
      expect(harness.handled).toHaveLength(0);
      expect(audit.failure).toHaveBeenCalledWith('transport', 'connection-limit');
    } finally {
      for (const socket of holders) socket.destroy();
    }
  });
});
