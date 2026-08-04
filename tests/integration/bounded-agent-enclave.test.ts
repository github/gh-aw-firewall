/**
 * Bounded-agent enclave integration test.
 *
 * Runs the *real*, unmodified AWF enclave bootstrap (`run-bounded-agent`)
 * against a fake local API proxy and a real on-disk repository seed, and
 * asserts the four properties that make the feature safe end to end:
 *
 *  1. the enclave reads the immutable seed through its read-only tools;
 *  2. its only outbound traffic is to the configured API-proxy endpoint;
 *  3. it produces a finite result that the trusted broker's schema validator
 *     accepts and canonicalizes;
 *  4. it fails closed — with no result file and no alternative destination —
 *     when that single permitted egress is unavailable.
 *
 * Docker is not required: the enclave bootstrap is standard-library Python and
 * the broker's validator is plain Node, so this exercises the real code paths
 * without a daemon. Container-level isolation (network membership, read-only
 * root, capability drop, seccomp, resource bounds) is asserted separately by
 * the exact-argument-vector unit tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/* eslint-disable @typescript-eslint/no-require-imports */
const repoRoot = path.join(__dirname, '..', '..');
const brokerDir = path.join(repoRoot, 'containers', 'bounded-agent', 'broker');
const { parseAndValidateQueryOutput } = require(path.join(brokerDir, 'protocol.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const ENCLAVE_ENTRYPOINT = path.join(repoRoot, 'containers', 'bounded-agent', 'enclave-entrypoint.py');

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

/** A fake, credential-free OpenAI-compatible endpoint standing in for the API proxy. */
class FakeApiProxy {
  readonly requests: RecordedRequest[] = [];
  private server?: http.Server;
  private responses: unknown[] = [];

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = {};
        }
        this.requests.push({ url: req.url ?? '', body, headers: req.headers });
        const next = this.responses.shift() ?? { choices: [{ message: { content: 'no tools' } }] };
        const payload = JSON.stringify(next);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as { port: number }).port;
  }

  enqueue(...responses: unknown[]): void {
    this.responses.push(...responses);
  }

  reset(): void {
    this.requests.length = 0;
    this.responses.length = 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

/** A destination the enclave must never contact. */
class ForbiddenUpstream {
  connections = 0;
  private server?: http.Server;

  async start(): Promise<number> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    this.server.on('connection', () => {
      this.connections += 1;
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

interface EnclaveRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runEnclave(layout: Record<string, string>, env: Record<string, string>): Promise<EnclaveRun> {
  const driver = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("enclave", ${JSON.stringify(ENCLAVE_ENTRYPOINT)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    `layout = module.Layout(${JSON.stringify(layout.seedDir)}, ${JSON.stringify(layout.taskPath)}, ` +
      `${JSON.stringify(layout.schemaPath)}, ${JSON.stringify(layout.outPath)})`,
    'sys.exit(module.run(layout))',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-c', driver],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code: number }).code
            : error ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** The final request carries the complete accumulated transcript. */
function transcriptOf(requests: RecordedRequest[]): Array<Record<string, unknown>> {
  const last = requests[requests.length - 1];
  return last ? ((last.body.messages as Array<Record<string, unknown>>) ?? []) : [];
}

const openAiToolCall = (id: string, name: string, args: unknown): unknown => ({
  choices: [
    {
      message: {
        role: 'assistant',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});

describe('bounded-agent enclave against a fake API proxy', () => {
  let workDir: string;
  let seedDir: string;
  let layout: Record<string, string>;
  let proxy: FakeApiProxy;
  let forbidden: ForbiddenUpstream;
  let proxyPort: number;
  let forbiddenPort: number;

  beforeAll(async () => {
    proxy = new FakeApiProxy();
    forbidden = new ForbiddenUpstream();
    proxyPort = await proxy.start();
    forbiddenPort = await forbidden.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await forbidden.stop();
  });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-e2e-'));
    seedDir = path.join(workDir, 'seed');
    fs.mkdirSync(path.join(seedDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'SECURITY.md'), 'SEED-MARKER-CONTENT\n');
    fs.writeFileSync(path.join(seedDir, 'docs', 'readme.md'), 'docs\n');

    layout = {
      seedDir,
      taskPath: path.join(workDir, 'task.txt'),
      schemaPath: path.join(workDir, 'schema.json'),
      outPath: path.join(workDir, 'out'),
    };
    fs.writeFileSync(layout.taskPath, 'Does this repository declare a SECURITY.md at its root?');
    fs.writeFileSync(layout.schemaPath, JSON.stringify({ type: 'boolean' }));
    fs.writeFileSync(layout.outPath, '');
    proxy.reset();
    forbidden.connections = 0;
  });

  const lastTranscript = (): Array<Record<string, unknown>> => transcriptOf(proxy.requests);

  const baseEnv = (): Record<string, string> => ({
    AWF_BOUNDED_AGENT_API_ENDPOINT: `http://127.0.0.1:${proxyPort}`,
    AWF_BOUNDED_AGENT_PROFILE: 'openai',
    AWF_BOUNDED_AGENT_MODEL: 'test-model',
    AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS: '4',
    AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS: '256',
    AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES: '8192',
    AWF_BOUNDED_AGENT_DEADLINE_SECONDS: '30',
  });

  test('reads the seed, calls only the API proxy, and produces a finite result', async () => {
    proxy.enqueue(
      openAiToolCall('call-1', 'list_files', { path: '.' }),
      openAiToolCall('call-2', 'read_file', { path: 'SECURITY.md' }),
      openAiToolCall('call-3', 'finish', { result: true }),
    );

    const result = await runEnclave(layout, baseEnv());
    expect(result.exitCode).toBe(0);

    // 1. The enclave read the immutable seed through its read-only tools and
    //    fed the contents back to the model.
    const toolMessages = lastTranscript()
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages.join('\n')).toContain('SEED-MARKER-CONTENT');
    expect(toolMessages.join('\n')).toContain('SECURITY.md');

    // 2. Every request went to the configured API-proxy route, unauthenticated
    //    (the proxy injects the real credential) — and nowhere else.
    expect(proxy.requests).toHaveLength(3);
    for (const request of proxy.requests) {
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(request.body.model).toBe('test-model');
      expect(request.body.max_tokens).toBe(256);
      expect(request.body.tool_choice).toBeUndefined();
      const tools = request.body.tools as Array<{
        function: {
          name: string;
          parameters: { properties: { result: unknown } };
        };
      }>;
      expect(tools.find((tool) => tool.function.name === 'finish')?.function.parameters)
        .toMatchObject({
          properties: { result: { type: 'boolean' } },
          required: ['result'],
          additionalProperties: false,
        });
    }
    expect(forbidden.connections).toBe(0);

    // 3. The result is exactly one JSON value in the dedicated bounded file,
    //    and the trusted broker validator accepts and canonicalizes it.
    const raw = fs.readFileSync(layout.outPath, 'utf8');
    expect(raw).toBe('true');
    expect(parseAndValidateQueryOutput(raw, { type: 'boolean' })).toEqual({
      ok: true,
      canonical: 'true',
    });

    // Nothing was written to the observable streams.
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('search refuses repository symlinks that resolve outside the seed', async () => {
    const outside = path.join(workDir, 'outside-secret.txt');
    fs.writeFileSync(outside, 'OUTSIDE-SEED-MARKER\n');
    fs.symlinkSync(outside, path.join(seedDir, 'escape.txt'));
    proxy.enqueue(
      openAiToolCall('call-1', 'search', { path: '.', pattern: 'OUTSIDE-SEED-MARKER' }),
      openAiToolCall('call-2', 'finish', { result: false }),
    );

    const result = await runEnclave(layout, baseEnv());
    expect(result.exitCode).toBe(0);
    const toolMessages = lastTranscript()
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages.join('\n')).not.toContain('escape.txt');
    expect(toolMessages.join('\n')).not.toContain('OUTSIDE-SEED-MARKER');
  });

  test('confines repository tools to the seed', async () => {
    proxy.enqueue(
      openAiToolCall('call-1', 'read_file', { path: '../../../etc/passwd' }),
      openAiToolCall('call-2', 'read_file', { path: '/etc/passwd' }),
      openAiToolCall('call-3', 'finish', { result: false }),
    );

    const result = await runEnclave(layout, baseEnv());
    expect(result.exitCode).toBe(0);

    const toolMessages = lastTranscript()
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages).toEqual([
      'error: not a file inside the repository',
      'error: not a file inside the repository',
    ]);
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('false');
  });

  test('rejects an unknown tool instead of executing anything', async () => {
    proxy.enqueue(
      openAiToolCall('call-1', 'run_shell', { command: 'id' }),
      openAiToolCall('call-2', 'finish', { result: true }),
    );

    await runEnclave(layout, baseEnv());
    const toolMessages = lastTranscript()
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages).toEqual(['error: unknown tool']);
  });

  test('bounds the number of model requests', async () => {
    for (let i = 0; i < 10; i += 1) {
      proxy.enqueue(openAiToolCall(`call-${i}`, 'list_files', { path: '.' }));
    }

    const result = await runEnclave(layout, { ...baseEnv(), AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS: '2' });
    expect(result.exitCode).toBe(31);
    expect(proxy.requests).toHaveLength(2);
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('');
  });

  test('fails closed with no result when its only permitted egress is unavailable', async () => {
    // Nothing is listening on this port: the enclave has no fallback route, no
    // proxy variable to fall back to, and no other destination to try.
    const deadPort = 1;
    const result = await runEnclave(layout, {
      ...baseEnv(),
      AWF_BOUNDED_AGENT_API_ENDPOINT: `http://127.0.0.1:${deadPort}`,
    });

    expect(result.exitCode).toBe(22);
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('');
    expect(proxy.requests).toHaveLength(0);
    expect(forbidden.connections).toBe(0);
    // No traceback, no diagnostics.
    expect(result.stderr).toBe('');
  });

  test('never reaches a non-proxy destination even when one is reachable', async () => {
    proxy.enqueue(openAiToolCall('call-1', 'finish', { result: true }));
    await runEnclave(layout, baseEnv());
    expect(forbidden.connections).toBe(0);
    expect(forbiddenPort).toBeGreaterThan(0);
  });

  test('speaks the Anthropic-compatible route when that profile is configured', async () => {
    proxy.enqueue({
      content: [{ type: 'tool_use', id: 'call-1', name: 'finish', input: { result: true } }],
    });

    const result = await runEnclave(layout, { ...baseEnv(), AWF_BOUNDED_AGENT_PROFILE: 'anthropic' });
    expect(result.exitCode).toBe(0);
    expect(proxy.requests[0].url).toBe('/v1/messages');
    expect(proxy.requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(proxy.requests[0].headers.authorization).toBeUndefined();
    expect(proxy.requests[0].body.tool_choice).toBeUndefined();
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('true');
  });

  test('forces only finish after a prose-only OpenAI response', async () => {
    proxy.enqueue(
      { choices: [{ message: { role: 'assistant', content: 'The answer is true.' } }] },
      openAiToolCall('call-1', 'finish', { result: true }),
    );

    const result = await runEnclave(layout, baseEnv());
    expect(result.exitCode).toBe(0);
    expect(proxy.requests[0].body.tool_choice).toBeUndefined();
    expect(proxy.requests[1].body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'finish' },
    });
    expect(transcriptOf([proxy.requests[1]])).toContainEqual({
      role: 'user',
      content: 'Call `finish` now with the finite result.',
    });
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('true');
  });

  test('forces only finish after a prose-only Anthropic response', async () => {
    proxy.enqueue(
      { content: [{ type: 'text', text: 'The answer is true.' }] },
      { content: [{ type: 'tool_use', id: 'call-1', name: 'finish', input: { result: true } }] },
    );

    const result = await runEnclave(layout, { ...baseEnv(), AWF_BOUNDED_AGENT_PROFILE: 'anthropic' });
    expect(result.exitCode).toBe(0);
    expect(proxy.requests[0].body.tool_choice).toBeUndefined();
    expect(proxy.requests[1].body.tool_choice).toEqual({ type: 'tool', name: 'finish' });
    expect(transcriptOf([proxy.requests[1]])).toContainEqual({
      role: 'user',
      content: 'Call `finish` now with the finite result.',
    });
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('true');
  });

  test('fails closed if a provider ignores forced finish', async () => {
    const prose = { choices: [{ message: { role: 'assistant', content: 'The answer is true.' } }] };
    proxy.enqueue(prose, prose);

    const result = await runEnclave(layout, {
      ...baseEnv(),
      AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS: '2',
    });
    expect(result.exitCode).toBe(31);
    expect(proxy.requests[1].body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'finish' },
    });
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('');
  });

  test('rejects an oversized result rather than truncating it', async () => {
    proxy.enqueue(openAiToolCall('call-1', 'finish', { result: true }));
    const result = await runEnclave(layout, { ...baseEnv(), AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES: '1' });

    expect(result.exitCode).toBe(30);
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('');
  });

  test('produces output the broker rejects when the model ignores the schema', async () => {
    proxy.enqueue(openAiToolCall('call-1', 'finish', { result: 'definitely maybe' }));
    await runEnclave(layout, baseEnv());

    const raw = fs.readFileSync(layout.outPath, 'utf8');
    expect(parseAndValidateQueryOutput(raw, { type: 'boolean' })).toEqual({ ok: false });
  });
});
