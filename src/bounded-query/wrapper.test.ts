import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/**
 * Behavioural tests for `containers/agent/bounded-query-wrapper.sh`, the only
 * bounded-query capability the agent receives (protocol v2).
 *
 * The wrapper is executed for real against a stub broker on a Unix socket, so
 * these assertions cover the actual shell semantics: accepted options
 * (`--repo`, `--schema`), the exact request framing (version header, repo
 * header, base64url-encoded schema header, raw script body), and —
 * critically — that every failure produces the identical canonical
 * `{"status":"error"}` on stdout, nothing on stderr, and exit status 0.
 */

const WRAPPER = path.join(__dirname, '..', '..', 'containers', 'agent', 'bounded-query-wrapper.sh');
const CANONICAL_ERROR = '{"status":"error"}';
const BOOLEAN_SCHEMA = '{"type":"boolean"}';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface StubRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Harness {
  socketPath: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

interface TcpHarness {
  endpoint: string;
  curlPathDir: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

async function startStubBroker(respond: (request: StubRequest) => string): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awfsp-'));
  const socketPath = path.join(dir, 'b.sock');
  const requests: StubRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record: StubRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      const body = respond(record);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

async function startStubTcpBroker(respond: (request: StubRequest) => string): Promise<TcpHarness> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(record);
      const body = respond(record);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP stub did not bind');
  const curlPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-curl-'));
  const curlPath = path.join(curlPathDir, 'curl');
  fs.writeFileSync(
    curlPath,
    `#!/bin/sh\nexec /usr/bin/curl --resolve host.docker.internal:${address.port}:127.0.0.1 "$@"\n`,
    { mode: 0o700 },
  );
  return {
    endpoint: `http://host.docker.internal:${address.port}/query`,
    curlPathDir,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => {
      fs.rmSync(curlPathDir, { recursive: true, force: true });
      resolve();
    })),
  };
}

interface WrapperResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Runs the wrapper asynchronously. `spawnSync` cannot be used here: the stub
 * broker listens on this process's event loop, which a synchronous spawn would
 * block, deadlocking the request.
 */
function runWrapper(
  args: string[],
  options: {
    socketPath?: string;
    endpoint?: string;
    capability?: string;
    script?: string;
    pathPrefix?: string;
  } = {},
): Promise<WrapperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [WRAPPER, ...args], {
      env: {
        PATH: [
          options.pathPrefix,
          process.env.PATH ?? '/usr/bin:/bin',
        ].filter(Boolean).join(':'),
        AWF_BOUNDED_QUERY_SOCKET: options.endpoint
          ? ''
          : (options.socketPath ?? '/nonexistent/awf-bounded-query.sock'),
        AWF_BOUNDED_QUERY_ENDPOINT: options.endpoint ?? '',
        AWF_BOUNDED_QUERY_CAPABILITY: options.capability ?? '',
        // Deliberately hostile proxy settings: the wrapper must ignore them.
        HTTP_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));

    child.stdin.on('error', () => { /* the wrapper may exit before reading stdin */ });
    child.stdin.end(options.script ?? 'print("query")\n');
  });
}

const VALID_ARGS = ['--repo', 'octo/private', '--schema', BOOLEAN_SCHEMA];

describe('bounded-query wrapper', () => {
  it('uses authenticated HTTP framing for an sbx agent', async () => {
    const capability = 'a'.repeat(64);
    const harness = await startStubTcpBroker(() => '{"status":"ok","result":true}');
    try {
      const result = await runWrapper(VALID_ARGS, {
        endpoint: harness.endpoint,
        capability,
        pathPrefix: harness.curlPathDir,
      });

      expect(result.stdout).toBe('{"status":"ok","result":true}\n');
      expect(harness.requests[0].headers['x-awf-capability']).toBe(capability);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects incomplete or ambiguous transport configuration locally', async () => {
    const results = await Promise.all([
      runWrapper(VALID_ARGS, { endpoint: 'http://host.docker.internal:12345/query' }),
      runWrapper(VALID_ARGS, { capability: 'a'.repeat(64) }),
      runWrapper(VALID_ARGS, {
        socketPath: '/tmp/broker.sock',
        endpoint: 'http://host.docker.internal:12345/query',
        capability: 'a'.repeat(64),
      }),
    ]);
    for (const result of results) {
      expect(result).toEqual({ stdout: `${CANONICAL_ERROR}\n`, stderr: '', status: 0 });
    }
  });

  it.each([
    'http://host.docker.internal:0/query',
    'http://host.docker.internal:65536/query',
    'http://host.docker.internal:12345/query/extra',
    'http://host.docker.internal:12345x/query',
    'http://127.0.0.1:12345/query',
    'https://host.docker.internal:12345/query',
  ])('rejects an untrusted sbx endpoint shape: %s', async (endpoint) => {
    await expect(runWrapper(VALID_ARGS, {
      endpoint,
      capability: 'a'.repeat(64),
    })).resolves.toEqual({ stdout: `${CANONICAL_ERROR}\n`, stderr: '', status: 0 });
  });

  it('forwards a valid request and prints the broker result verbatim', async () => {
    const harness = await startStubBroker(() => '{"status":"ok","result":true}');
    try {
      const result = await runWrapper(VALID_ARGS, { socketPath: harness.socketPath });

      expect(result.stdout).toBe('{"status":"ok","result":true}\n');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('sends only the fixed v2 framing: version, repo, base64url schema, raw script body', async () => {
    const harness = await startStubBroker(() => '{"status":"ok","result":false}');
    try {
      await runWrapper(VALID_ARGS, { socketPath: harness.socketPath, script: 'import json\n' });

      expect(harness.requests).toHaveLength(1);
      const request = harness.requests[0];
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/query');
      expect(request.body).toBe('import json\n');
      expect(request.headers['x-awf-query-version']).toBe('2');
      expect(request.headers['x-awf-repo']).toBe('octo/private');
      expect(request.headers['x-awf-schema-b64']).toBe(base64url(BOOLEAN_SCHEMA));

      const awfHeaders = Object.keys(request.headers).filter((name) => name.startsWith('x-awf-'));
      expect(awfHeaders.sort()).toEqual(['x-awf-query-version', 'x-awf-repo', 'x-awf-schema-b64']);
    } finally {
      await harness.close();
    }
  });

  it('base64url-encodes a schema containing +, /, and padding-triggering lengths without leaking raw JSON in headers', async () => {
    const harness = await startStubBroker(() => '{"status":"ok","result":"A"}');
    try {
      const schema = JSON.stringify({ type: 'enum', values: ['A', 'B', 'C'] });
      await runWrapper(['--repo', 'octo/private', '--schema', schema], { socketPath: harness.socketPath });

      const request = harness.requests[0];
      const headerValue = String(request.headers['x-awf-schema-b64']);
      expect(headerValue).toBe(base64url(schema));
      // base64url must never contain the standard-base64 `+`, `/`, or `=` characters.
      expect(headerValue).not.toMatch(/[+/=]/);
      expect(Buffer.from(headerValue, 'base64').toString('utf8')).toBe(schema);
    } finally {
      await harness.close();
    }
  });

  it('passes through the canonical error result unmodified', async () => {
    const harness = await startStubBroker(() => CANONICAL_ERROR);
    try {
      const result = await runWrapper(VALID_ARGS, { socketPath: harness.socketPath });
      expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ['a result missing the ok/error envelope', '{"result":true}'],
    ['a non-canonical encoding', '{ "status" : "ok", "result" : true }'],
    ['malformed JSON', '{"status":'],
    ['an empty body', ''],
    ['unexpected prose', 'boom'],
    ['an unknown status value', '{"status":"maybe","result":true}'],
  ])('replaces %s from the broker with the canonical error', async (_name, body) => {
    const harness = await startStubBroker(() => body);
    try {
      const result = await runWrapper(VALID_ARGS, { socketPath: harness.socketPath });
      expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('emits the canonical error locally when the broker socket is unavailable', async () => {
    const result = await runWrapper(VALID_ARGS);
    expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  describe('rejects unsupported input without contacting the broker', () => {
    const oversizedSchema = JSON.stringify({ type: 'enum', values: Array.from({ length: 700 }, (_, i) => `v${i}`) });

    const cases: Array<[string, string[]]> = [
      ['no arguments', []],
      ['missing repo', ['--schema', BOOLEAN_SCHEMA]],
      ['missing schema', ['--repo', 'octo/private']],
      ['empty schema', ['--repo', 'octo/private', '--schema', '']],
      ['oversized schema (over MAX_SCHEMA_BYTES)', ['--repo', 'octo/private', '--schema', oversizedSchema]],
      ['repeated repo', ['--repo', 'octo/a', '--repo', 'octo/b', '--schema', BOOLEAN_SCHEMA]],
      ['repeated schema', ['--repo', 'octo/private', '--schema', BOOLEAN_SCHEMA, '--schema', BOOLEAN_SCHEMA]],
      ['url repo', ['--repo', 'https://github.com/octo/private', '--schema', BOOLEAN_SCHEMA]],
      ['traversal repo', ['--repo', 'octo/../etc', '--schema', BOOLEAN_SCHEMA]],
      ['wildcard repo', ['--repo', 'octo/*', '--schema', BOOLEAN_SCHEMA]],
      ['equals-form repo option', ['--repo=octo/private', '--schema', BOOLEAN_SCHEMA]],
      ['equals-form schema option', ['--repo', 'octo/private', `--schema=${BOOLEAN_SCHEMA}`]],
      ['positional argument', [...VALID_ARGS, 'extra']],
      ['unsupported --image', [...VALID_ARGS, '--image', 'evil']],
      ['unsupported --timeout', [...VALID_ARGS, '--timeout', '9999']],
      ['unsupported --runtime', [...VALID_ARGS, '--runtime', 'runc']],
      ['unsupported --mount', [...VALID_ARGS, '--mount', '/etc:/etc']],
      ['unsupported --env', [...VALID_ARGS, '--env', 'GH_TOKEN=x']],
      ['unsupported --ref', [...VALID_ARGS, '--ref', 'main']],
      ['dangling --repo', ['--repo']],
      ['dangling --schema', ['--repo', 'octo/private', '--schema']],
    ];

    it.each(cases)('%s', async (_name, args) => {
      const harness = await startStubBroker(() => '{"status":"ok","result":true}');
      try {
        const result = await runWrapper(args, { socketPath: harness.socketPath });

        expect(result.stdout).toBe(`${CANONICAL_ERROR}\n`);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(harness.requests).toHaveLength(0);
      } finally {
        await harness.close();
      }
    });
  });

  it('produces a byte-identical answer for every failure mode', async () => {
    const harness = await startStubBroker(() => '{"result":"MAYBE"}');
    try {
      const outputs = await Promise.all([
        runWrapper(VALID_ARGS, { socketPath: harness.socketPath }),
        runWrapper([...VALID_ARGS, '--image', 'evil'], { socketPath: harness.socketPath }),
        runWrapper(['--repo', 'octo/*', '--schema', BOOLEAN_SCHEMA]),
        runWrapper(VALID_ARGS),
      ]);

      for (const output of outputs) {
        expect(output.stdout).toBe(`${CANONICAL_ERROR}\n`);
        expect(output.stderr).toBe('');
        expect(output.status).toBe(0);
      }
    } finally {
      await harness.close();
    }
  });
});
