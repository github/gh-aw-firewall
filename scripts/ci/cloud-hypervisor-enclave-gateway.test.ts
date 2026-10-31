import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { once } from 'events';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { assertEnclaveGatewayReady } from '../../src/enclave/gateway';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import { getEnclaveStartupProgress } from '../../src/enclave/startup-progress';
import type { WrapperConfig } from '../../src/types';
import { validateSchema, validateValueAgainstSchema } from '../../src/bounded-execution/finite-schema';
import { takeStaticGithubExecutorCapability, getStaticGithubExecutorCapability } from '../../src/enclave/static-github-handoff';
import { assertCloudHypervisorPreSecurityCompatibility } from '../../src/cloud-hypervisor/runtime-validation';

/* eslint-disable @typescript-eslint/no-require-imports */
const { dispatchJsonRpc } = require('../../containers/enclave/mcp-server/mcp-protocol.js');
const { createToolCallBudget } = require('../../containers/enclave/mcp-server/tool-call-budget.js');
const {
  makeGithubFixtureCapability, buildScopedGithubGuestProbe, makeConfig, toAwfConfig,
  buildAgentGuestProbe,
} = require('./cloud-hypervisor-enclave-live-smoke.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const fixture = path.resolve(__dirname, 'cloud-hypervisor-enclave-gateway.js');
const apiKey = 'k'.repeat(40);
const capability = 'a'.repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function post(port: number, body: unknown, route = '/mcp/awf-enclave', authorization = apiKey): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request({
          host: '127.0.0.1', port, path: route, method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        });
        request.on('error', reject);
        request.end(payload);
      });
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('Cloud Hypervisor enclave gateway fixture', () => {
  let gateway: ChildProcess | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const closed = once(gateway, 'close');
      gateway.kill();
      await closed;
    }
    gateway = undefined;
    if (upstream) await new Promise((resolve) => upstream?.close(resolve));
    upstream = undefined;
  });

  async function startGateway(upstreamPort: number, environment: NodeJS.ProcessEnv = {}): Promise<number> {
    const port = await freePort();
    gateway = spawn(process.execPath, [fixture], {
      env: {
        PATH: process.env.PATH,
        MCP_GATEWAY_PORT: String(port),
        MCP_GATEWAY_API_KEY: apiKey,
        AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`,
        ...environment,
      },
      stdio: 'ignore',
    });
    return port;
  }

  describe('scoped static GitHub controlled route (no VM in deterministic tests)', () => {
    const identity = 'scoped-github-live-fixture';
    const issueArgs = { owner: 'github', repo: 'gh-aw-firewall', method: 'get', issue_number: 1 };
    const message = (name: string, args: unknown = issueArgs) => ({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    });
    const environmentFor = (value: ReturnType<typeof makeGithubFixtureCapability>) => ({
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: identity,
      AWF_ENCLAVE_GITHUB_MCP_AGENT_ID: value.agentId,
      AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY: JSON.stringify(value),
    });

    it('issues an exact compiler handoff, opts configuration in, and preserves the disabled default', () => {
      const value = makeGithubFixtureCapability(identity, apiKey);
      expect(value).toEqual({
        version: 1, gatewayIdentity: identity, executor: 'agent', agentId: expect.stringMatching(/^[a-f0-9]{64}$/),
        bearer: expect.stringMatching(/^[\x21-\x7e]{32,512}$/),
        issuedAt: expect.any(Number), expiresAt: value.issuedAt + 3600_000,
        allowedTools: ['issue_read', 'list_issues'], allowedRepos: ['github/gh-aw-firewall'], minIntegrity: null,
      });
      expect([apiKey, value.agentId]).not.toContain(value.bearer);
      const artifacts = { directory: '/artifacts', tag: 'v0.0.0' };
      const disabled = makeConfig(artifacts, '/work', '/workspace', {});
      const enabled = makeConfig(artifacts, '/work', '/workspace', { githubCapability: value });
      expect(disabled.enclaves[1].agent.tools).toBeUndefined();
      expect(enabled.enclaves[1].agent.tools.github).toEqual({
        allowed: value.allowedTools, allowedRepos: value.allowedRepos,
      });
      expect(JSON.parse(JSON.stringify(toAwfConfig(enabled))).enclaves[1].agent.tools.github).toEqual({
        allowed: ['issue_read', 'list_issues'], allowedRepos: ['github/gh-aw-firewall'],
      });
      expect(enabled.container.containerRuntime).toBe('docker');
      expect(disabled.container.containerRuntime).toBe('cloud-hypervisor');
      expect(JSON.stringify(toAwfConfig(enabled))).not.toContain(value.bearer);
      const wrapper = {
        ...enabled, containerRuntime: enabled.container.containerRuntime,
        networkIsolation: true, enableApiProxy: true,
        workDir: '/work', enclaves: normalizeEnclavesConfig(enabled.enclaves),
      } as WrapperConfig;
      expect(() => assertCloudHypervisorPreSecurityCompatibility(wrapper)).not.toThrow();
      expect(() => assertCloudHypervisorPreSecurityCompatibility({
        ...wrapper, containerRuntime: 'cloud-hypervisor',
      })).toThrow(/primary-agent execution with enclaves is reserved/);
      const scriptOnly = makeConfig(artifacts, '/work', '/workspace', { githubCapability: value }, 'script-only');
      expect(scriptOnly.container.containerRuntime).toBe('cloud-hypervisor');
      expect(scriptOnly.enclaves).toHaveLength(1);
      expect(scriptOnly.enclaves[0].agent).toBeUndefined();
      const agentOnly = makeConfig(artifacts, '/work', '/workspace', { githubCapability: value }, 'agent-only');
      expect(agentOnly.container.containerRuntime).toBe('docker');
      expect(() => assertCloudHypervisorPreSecurityCompatibility({
        ...wrapper, enclaves: normalizeEnclavesConfig(agentOnly.enclaves),
      })).not.toThrow();
      const handoffEnvironment = { ...environmentFor(value), MCP_GATEWAY_API_KEY: apiKey };
      expect(() => takeStaticGithubExecutorCapability(wrapper, handoffEnvironment)).not.toThrow();
      expect(getStaticGithubExecutorCapability(wrapper)).toEqual(value);
      expect(handoffEnvironment).not.toHaveProperty('AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY');
      expect(buildAgentGuestProbe().expected.githubPeerBlocked).toBe(true);
      expect(buildAgentGuestProbe({ githubEnabled: true }).expected.githubPeerBlocked).toBe(false);
    });

    it('runs the actual guest diagnostic against the controlled HTTP fixture and staged source', async () => {
      const value = makeGithubFixtureCapability(identity, apiKey);
      const port = await startGateway(await freePort(), environmentFor(value));
      const auth = value.bearer;
      await expect(post(port, message('issue_read'), '/mcp/github', auth)).resolves.toMatchObject({
        status: 200, body: { result: { structuredContent: {
          number: 1, title: 'AWF controlled scoped issue', repository: 'github/gh-aw-firewall',
        } } },
      });
      await expect(post(port, message('issue_read'), '/mcp/github', ['Bearer', auth].join(' ')))
        .resolves.toEqual({ status: 403, body: { error: 'forbidden' } });
      await expect(post(port, message('list_issues', { owner: 'github', repo: 'gh-aw-firewall' }),
        '/mcp/github', auth)).resolves.toMatchObject({ status: 200, body: { result: {
        structuredContent: { issues: [{ number: 1 }] },
      } } });
      const directory = path.join(process.cwd(), `.scoped-github-fixture-${randomUUID()}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      try {
        const source = path.join(directory, 'README.md');
        const config = path.join(directory, 'github-mcp.json');
        const out = path.join(directory, 'out');
        fs.writeFileSync(source, 'Controlled staged source\n');
        fs.writeFileSync(config, JSON.stringify({ mcpServers: { github: {
          url: `http://127.0.0.1:${port}/mcp/github`,
          headers: { Authorization: auth }, tools: value.allowedTools,
        } } }), { mode: 0o600 });
        const probe = buildScopedGithubGuestProbe();
        expect(Buffer.byteLength(probe.prompt)).toBeLessThanOrEqual(4096);
        const parsed = validateSchema(probe.schema);
        expect(parsed.valid).toBe(true);
        if (parsed.valid) expect(validateValueAgainstSchema(parsed.schema, probe.expected)).toBe(true);
        // Only this deterministic diagnostic test substitutes paths/loopback.
        // The live harness retains the real VM and fixed .40 endpoint.
        const script = probe.python
          .replaceAll('/awf/seed/README.md', source).replaceAll('/agent/github-mcp.json', config)
          .replaceAll('/awf/out', out)
          .replaceAll('http://172.31.0.40:8080/mcp/github', `http://127.0.0.1:${port}/mcp/github`);
        const result = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
        expect(JSON.parse(result)).toEqual(probe.expected);
        expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(probe.expected);
        expect(result).not.toContain(value.bearer);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it.each([
      ['gateway-wide key', apiKey], ['broker capability', capability], ['wrong bearer', 'x'.repeat(40)],
      ['static executor identity', 'agent-id'], ['missing bearer', ''],
    ])('denies %s, including identities that are not scoped bearers', async (_label, rejected) => {
      const value = makeGithubFixtureCapability(identity, apiKey);
      const port = await startGateway(await freePort(), environmentFor(value));
      for (const auth of [rejected, ['Bearer', rejected].join(' '), value.agentId]) {
        await expect(post(port, message('issue_read'), '/mcp/github', auth))
          .resolves.toEqual({ status: 403, body: { error: 'forbidden' } });
      }
    });

    it.each([
      message('issue_write'),
      message('issue_read', { ...issueArgs, repo: 'other' }),
      message('issue_read', { ...issueArgs, owner: 'Github' }),
      message('issue_read', { ...issueArgs, method: 'get_comments' }),
      message('issue_read', { ...issueArgs, issue_number: 2 }),
      message('list_issues', { owner: 'github', repo: 'gh-aw-firewall', query: 'repo:other/private' }),
    ])('rejects tools, repositories, and argument escape paths: %j', async (request) => {
      const value = makeGithubFixtureCapability(identity, apiKey);
      const port = await startGateway(await freePort(), environmentFor(value));
      await expect(post(port, request, '/mcp/github', value.bearer))
        .resolves.toEqual({ status: 403, body: { error: 'forbidden' } });
    });

    it('denies expired capabilities on every method instead of falling back to broad credentials', async () => {
      const value = makeGithubFixtureCapability(identity, apiKey, Date.now() - 3600_001);
      const port = await startGateway(await freePort(), environmentFor(value));
      for (const method of ['initialize', 'tools/list', 'tools/call']) {
        await expect(post(port, { ...message('issue_read'), method }, '/mcp/github',
          value.bearer)).resolves.toEqual({ status: 403, body: { error: 'forbidden' } });
      }
    });

    it('does not expose the controlled GitHub route without opt-in', async () => {
      const port = await startGateway(await freePort());
      await expect(post(port, message('issue_read'), '/mcp/github'))
        .resolves.toEqual({ status: 404, body: { error: 'not found' } });
    });

    it.each([
      { executor: 'script' }, { gatewayIdentity: 'different-gateway' }, { agentId: 'other-agent'.repeat(4) },
      { bearer: apiKey }, { allowedTools: ['issue_read', 'issue_write'] },
      { allowedRepos: ['other/private'] }, { minIntegrity: 'unconfigured' },
      { expiresAt: Date.now() + 7200_000 }, { issuedAt: Date.now() + 3600_000 },
    ])('refuses mismatched capability issuance %j', async (patch) => {
      const value = makeGithubFixtureCapability(identity, apiKey);
      const env = environmentFor(value);
      env.AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY = JSON.stringify({ ...value, ...patch });
      await startGateway(await freePort(), env);
      const [code] = await once(gateway!, 'close');
      expect(code).not.toBe(0);
    });
  });

  async function protocolGateway(
    profile: 'script' | 'agent' | 'combined',
    limit?: number,
    mutateTools: (tools: Record<string, unknown>[]) => Record<string, unknown>[] = (tools) => tools,
  ) {
    const handlers = {
      ...(profile !== 'agent' ? { enclave_run_script: {} } : {}),
      ...(profile !== 'script' ? { enclave_run_agent: {} } : {}),
    };
    const toolCallBudget = createToolCallBudget({ maxToolCalls: limit });
    const methods: string[] = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          expect(request.headers.authorization).toBe(`Bearer ${capability}`);
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          methods.push(message.method);
          const result = await dispatchJsonRpc(message, { handlers, toolCallBudget });
          if (result === undefined) {
            response.writeHead(202, { 'content-length': '0' });
            response.end();
            return;
          }
          if (message.method === 'tools/list') result.result.tools = mutateTools(result.result.tools);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(result));
        })().catch((error: Error) => response.destroy(error));
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    // Wait for the fixture listener before testing the non-retryable readiness transport.
    await post(port, { jsonrpc: '2.0', id: 0, method: 'initialize' });
    methods.length = 0;
    const repos = [{ repo: 'octo/public', sensitivity: 'public' as const }];
    const wrapper = {
      workDir: '/tmp/awf-test',
      maxNumToolCalls: limit,
      enclaves: normalizeEnclavesConfig([
        ...(profile !== 'agent' ? [{ script: {}, repos }] : []),
        ...(profile !== 'script' ? [{ agent: { model: 'gpt-test' }, repos }] : []),
      ]),
    } as WrapperConfig;
    const environment = {
      AWF_ENCLAVE_MCP_CAPABILITY: capability,
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'test-run-identity',
      AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: `http://127.0.0.1:${port}/mcp/awf-enclave`,
      MCP_GATEWAY_API_KEY: apiKey,
    };
    return { wrapper, environment, methods, toolCallBudget };
  }

  describe.each(['script', 'agent', 'combined'] as const)('%s protocol readiness', (profile) => {
    it.each([undefined, 1, 16])('matches the real broker tool listing with cap %s', async (limit) => {
      const { wrapper, environment, methods, toolCallBudget } = await protocolGateway(profile, limit);
      await expect(assertEnclaveGatewayReady(wrapper, environment, 1000)).resolves.toBeUndefined();
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({ readiness: 'ready', code: 'ready' });
      expect(toolCallBudget?.used() ?? 0).toBe(0);
    });
  });

  it.each([
    ['missing advisory', (tools: Record<string, unknown>[]) => tools.map((tool) => ({
      ...tool, description: String(tool.description).split(' You are allowed')[0],
    }))],
    ['wrong cap', (tools: Record<string, unknown>[]) => tools.map((tool) => ({
      ...tool, description: String(tool.description).replace('at most 16', 'at most 15'),
    }))],
    ['changed description', (tools: Record<string, unknown>[]) => tools.map((tool) => ({
      ...tool, description: `${String(tool.description)} extra`,
    }))],
    ['changed schema', (tools: Record<string, unknown>[]) => tools.map((tool) => ({
      ...tool, inputSchema: { type: 'object' },
    }))],
    ['unexpected tool', (tools: Record<string, unknown>[]) => [...tools, { name: 'unexpected' }]],
    ['duplicate tool', (tools: Record<string, unknown>[]) => [...tools, tools[0]]],
    ['missing executor', (tools: Record<string, unknown>[]) => tools.slice(1)],
  ] as const)('rejects %s with a configured cap', async (_label, mutateTools) => {
    const { wrapper, environment, methods } = await protocolGateway('combined', 16, mutateTools);
    await expect(assertEnclaveGatewayReady(wrapper, environment, 1000))
      .rejects.toThrow('Gateway enclave tool contract did not exactly match');
    expect(getEnclaveStartupProgress(wrapper)).toMatchObject({ code: 'tools-mismatch' });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  }, 15_000);

  it('reports an unreachable backend with the retryable mcpg backend_unavailable contract', async () => {
    const port = await startGateway(await freePort());
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 503, body: { error: 'backend_unavailable', retryable: true },
    });
  });

  it('completes initialize, the empty initialized acknowledgment, and routed tool discovery', async () => {
    const methods: string[] = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        methods.push(message.method);
        if (message.method === 'notifications/initialized') {
          response.writeHead(202, { 'content-length': '0' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: message.method === 'initialize' ? { serverInfo: { name: 'inner' } }
            : { tools: [{ name: 'enclave_run_script', description: 'bounded script', inputSchema: {} }] },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'awmg-awf-enclave', version: 'live-test' } } },
    });
    await expect(post(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toEqual({
      status: 202, body: undefined,
    });
    await expect(post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).resolves.toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 2, result: { tools: [{
        name: 'enclave_run_script', description: '[awf-enclave] bounded script', inputSchema: {},
      }] } },
    });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('keeps an invalid backend response permanent', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end('not json'));
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 502, body: { error: 'invalid upstream response' },
    });
  });

  it.each([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } },
  ])('preserves empty notification acknowledgments for $method', async (notification) => {
    const received: unknown[] = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(request.headers.authorization).toBe(`Bearer ${capability}`);
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(202, { 'content-length': '0' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, notification)).resolves.toEqual({ status: 202, body: undefined });
    expect(received).toEqual([notification]);
    expect(gateway?.exitCode).toBeNull();
  });

  it.each([
    { status: 202, request: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
    { status: 202, request: { jsonrpc: '2.0', id: null, method: 'initialize' } },
    { status: 202, request: { method: 'notifications/initialized' } },
    { status: 202, request: { jsonrpc: '2.0' } },
    { status: 200, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    { status: 401, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    { status: 503, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
  ])('does not accept an empty $status response for $request', async ({ status, request }) => {
    upstream = http.createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        response.writeHead(status, { 'content-length': '0' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, request)).resolves.toEqual({
      status: 502, body: { error: 'invalid upstream response' },
    });
  });

  it('returns permanent failures for truncated backend responses without terminating the gateway', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        response.write('{"jsonrpc":');
        setTimeout(() => response.destroy(), 20);
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
        status: 502, body: { error: 'upstream unavailable' },
      });
    }
    expect(gateway?.exitCode).toBeNull();
  });

  it('keeps oversized backend responses permanent without terminating the gateway', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end('x'.repeat(420 * 1024 + 1)));
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
        status: 502, body: { error: 'upstream response exceeded its bound' },
      });
    }
    expect(gateway?.exitCode).toBeNull();
  });

  it.each([
    'http://example.com:80/mcp',
    'http://127.0.0.1:0/mcp',
    'http://127.0.0.1:65536/mcp',
    'http://127.0.0.1:99999/mcp',
    'http://awf-enclave-mcp:0/mcp',
    'http://awf-enclave-mcp:65536/mcp',
    'http://awf-enclave-mcp:99999/mcp',
  ])('refuses invalid test upstream override %s at startup', async (upstreamUrl) => {
    const child = spawn(process.execPath, [fixture], {
      env: {
        PATH: process.env.PATH, MCP_GATEWAY_API_KEY: apiKey, AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM: upstreamUrl,
      },
      stdio: 'ignore',
    });
    await expect(new Promise((resolve) => child.once('exit', resolve))).resolves.not.toBe(0);
  });
});
