import * as http from 'http';
import * as path from 'path';
import execa from 'execa';
import { EventEmitter } from 'events';
import {
  getEnclaveStartupProgress, initializeEnclaveStartupProgress,
  type EnclaveStartupProgress,
} from './startup-progress';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
  assertEnclaveGatewayReady,
  buildEnclaveMcpgUpstreamContract,
  connectEnclaveGateway,
  enclaveGatewayTestHelpers,
  resolveEnclaveGatewayContract,
  shutdownEnclaveGateway,
} from './gateway';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const enclaveProtocol = require(path.join(
  __dirname,
  '../../containers/enclave/mcp-server/mcp-protocol.js',
));

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

const repository = { repo: 'octo/private', sensitivity: 'internal' as const };

function config(agent = false): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    enclaves: normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      ...(agent ? [{ agent: { model: 'gpt-test' }, repos: [repository] }] : []),
    ]),
  } as WrapperConfig;
}

function env(endpoint = 'http://127.0.0.1:8080/mcp/awf-enclave'): NodeJS.ProcessEnv {
  return {
    AWF_ENCLAVE_MCP_CAPABILITY: 'a'.repeat(64),
    AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'test-run-identity',
    AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: 'awmg-mcpg',
    AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
    MCP_GATEWAY_API_KEY: 'g'.repeat(48),
  };
}

function routedTool(tool: Record<string, unknown>): Record<string, unknown> {
  return {
    name: tool.name,
    description: `[awf-enclave] ${String(tool.description)}`,
    inputSchema: tool.inputSchema,
  };
}

function listen(
  tools: unknown[],
  options: {
    unavailableInitializations?: number;
    unavailableRetryable?: boolean;
    initializationStatus?: number;
    initializationBody?: string;
    initializationRpcError?: boolean;
    serverName?: string;
    oversizedInitialization?: boolean;
    hangInitialization?: boolean;
    trickleInitialization?: boolean;
    sse?: boolean;
    failureMethod?: string;
  } = {},
): Promise<{
  endpoint: string;
  initializeAttempts: () => number;
  authorizationHeaders: () => Array<string | undefined>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let initializeAttempts = 0;
    const authorizationHeaders: Array<string | undefined> = [];
    const server = http.createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number;
          method: string;
        };
        response.setHeader(
          'content-type',
          options.sse ? 'text/event-stream' : 'application/json',
        );
        response.setHeader('mcp-session-id', 'session-1');
        if (options.failureMethod === message.method) {
          response.statusCode = options.initializationStatus ?? 403;
          response.end(options.initializationBody ?? 'PRIVATE_BODY');
          return;
        }
        if (message.method === 'initialize') {
          initializeAttempts += 1;
          if (options.hangInitialization) return;
          if (options.trickleInitialization) {
            const interval = setInterval(() => response.write(' '), 5);
            response.on('close', () => clearInterval(interval));
            return;
          }
          if (
            options.unavailableInitializations
            && initializeAttempts <= options.unavailableInitializations
          ) {
            response.statusCode = 503;
            response.end(JSON.stringify({
              error: 'backend_unavailable',
              message: 'Backend MCP server is not ready; retry initialization',
              ...(options.unavailableRetryable === undefined
                ? {}
                : { retryable: options.unavailableRetryable }),
            }));
            return;
          }
          if (options.initializationStatus) {
            response.statusCode = options.initializationStatus;
            response.end(options.initializationBody ?? JSON.stringify({
              error: 'permanent_failure',
              retryable: false,
            }));
            return;
          }
          if (options.initializationRpcError) {
            response.end(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: 'permanent failure' },
            }));
            return;
          }
          if (options.oversizedInitialization) {
            response.end('x'.repeat(256 * 1024 + 1));
            return;
          }
        }
        if (message.method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
          return;
        }
        const result = message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: options.serverName ?? 'awmg-awf-enclave',
                version: '1.0.0',
              },
            }
          : { tools };
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        response.end(options.sse ? `data: ${payload}\n\n` : payload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolve({
        endpoint: `http://127.0.0.1:${address.port}/mcp/awf-enclave`,
        initializeAttempts: () => initializeAttempts,
        authorizationHeaders: () => authorizationHeaders,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('enclave mcpg handoff', () => {
  beforeEach(() => mockExeca.mockReset());
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['ENOTFOUND', 'dns-not-found'], ['EAI_AGAIN', 'dns-temporary'],
    ['ECONNREFUSED', 'connection-refused'], ['ETIMEDOUT', 'connection-timeout'],
    ['ENETUNREACH', 'network-unreachable'], ['EHOSTUNREACH', 'host-unreachable'],
    ['ECONNRESET', 'connection-reset'], ['SECRET\n/private/192.0.2.1', 'transport-other'],
  ])('classifies actual request errors without serializing their payload: %s', async (errno, code) => {
    const events: EnclaveStartupProgress[] = [];
    const wrapper = config();
    initializeEnclaveStartupProgress(wrapper, (event) => events.push(event));
    const secret = 'PRIVATE_TOKEN_secret.example_192.0.2.1_/private/path\nrepository-sentinel';
    const transport = jest.requireActual<typeof http>('http');
    jest.spyOn(transport, 'request').mockImplementation(() => {
      const request = new EventEmitter();
      Object.assign(request, {
        end: () => process.nextTick(() => request.emit('error', Object.assign(
          new Error(secret), { code: errno, hostname: secret, address: secret },
        ))),
      });
      return request as http.ClientRequest;
    });
    await expect(assertEnclaveGatewayReady(wrapper, env(), 1000))
      .rejects.toThrow('Gateway readiness transport failed');
    expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
      perspective: 'awf-host', stage: 'initialize', readiness: 'attempted',
      code, attempts: 1, httpStatus: null,
    });
    expect(getEnclaveStartupProgress(wrapper)?.startupChecks).toMatchObject({
      ready: false, checks: {
        'gateway-handshake/initialize': ['failed', code],
        'gateway-handshake/initialized': ['not-attempted', 'none'],
        'gateway-handshake/tools-list': ['not-attempted', 'none'],
      },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(errno);
  });

  it.each([
    [401, 'private token', 'http-auth'],
    [403, 'secret.example/192.0.2.1', 'http-auth'],
    [500, 'PRIVATE_BODY', 'http-status'],
    [503, '{"error":"backend_unavailable","retryable":false}', 'http-status'],
    [503, '{', 'http-status'],
    [200, '{PRIVATE_BODY', 'malformed-json'],
    [200, 'null', 'malformed-protocol'],
    [200, '[]', 'malformed-protocol'],
    [200, '{"jsonrpc":"2.0","id":999,"result":{}}', 'malformed-protocol'],
  ])('records bounded HTTP/protocol failure %s without retrying', async (status, body, code) => {
    const wrapper = config();
    const server = await listen([], { initializationStatus: status, initializationBody: body });
    try {
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000)).rejects.toThrow();
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        stage: 'initialize', readiness: 'attempted', code, attempts: 1,
        httpStatus: status === 200 ? null : status,
      });
      expect(getEnclaveStartupProgress(wrapper)?.startupChecks?.checks['gateway-handshake/initialize'])
        .toEqual(['failed', code]);
      expect(server.initializeAttempts()).toBe(1);
      if (body.length > 4) expect(JSON.stringify(getEnclaveStartupProgress(wrapper))).not.toContain(body);
    } finally {
      await server.close();
    }
  });

  it.each([
    ['notifications/initialized', 'initialized'], ['tools/list', 'tools-list'],
  ])('records the actual failing request phase %s', async (failureMethod, stage) => {
    const wrapper = config();
    const server = await listen([], { failureMethod });
    try {
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000)).rejects.toThrow();
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        stage, readiness: 'attempted', code: 'http-auth', httpStatus: 403, attempts: 1,
      });
      expect(getEnclaveStartupProgress(wrapper)?.startupChecks?.checks[`gateway-handshake/${stage}`])
        .toEqual(['failed', 'http-auth']);
    } finally {
      await server.close();
    }
  });

  it('leaves invalid readiness handoff explicitly not attempted', async () => {
    const wrapper = config();
    await expect(assertEnclaveGatewayReady(wrapper, { ...env(), MCP_GATEWAY_API_KEY: '' }))
      .rejects.toThrow(/MCP_GATEWAY_API_KEY/);
    expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
      stage: 'gateway-contract', readiness: 'not-attempted', attempts: 0, code: 'none',
    });
  });

  it('does not claim a request when the budget expires before initialize', async () => {
    const wrapper = config();
    const transport = jest.requireActual<typeof http>('http');
    const request = jest.spyOn(transport, 'request');
    await expect(assertEnclaveGatewayReady(wrapper, env(), 0)).rejects.toThrow(/deadline expired/);
    expect(request).not.toHaveBeenCalled();
    expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
      stage: 'gateway-contract', readiness: 'not-attempted', attempts: 0, code: 'readiness-deadline',
    });
  });

  it('generates the exact static compiler upstream without secret material', () => {
    expect(buildEnclaveMcpgUpstreamContract(config(true))).toEqual({
      name: 'awf-enclave',
      server: {
        type: 'http',
        url: 'http://awf-enclave-mcp:8080/mcp',
        headers: { Authorization: 'Bearer ${AWF_ENCLAVE_MCP_CAPABILITY}' },
        tools: ['enclave_run_script', 'enclave_run_agent'],
        connectTimeout: 120,
        toolTimeout: 4860,
      },
      handoff: {
        capabilityEnv: 'AWF_ENCLAVE_MCP_CAPABILITY',
        gatewayContainerEnv: 'AWF_ENCLAVE_MCP_GATEWAY_CONTAINER',
        gatewayEndpointEnv: 'AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT',
        gatewayIdentityEnv: 'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY',
        readinessTimeoutEnv: 'AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS',
        gatewayRunLabel: ENCLAVE_MCP_GATEWAY_RUN_LABEL,
      },
    });
  });

  it('keeps readiness contracts byte-equivalent to the server tool definitions', () => {
    expect(enclaveGatewayTestHelpers.expectedTools(config(true))).toEqual([
      enclaveProtocol.TOOL,
      enclaveProtocol.AGENT_TOOL,
    ]);
    expect(enclaveGatewayTestHelpers.expectedRoutedTools([
      enclaveProtocol.TOOL,
    ])).toEqual([routedTool(enclaveProtocol.TOOL)]);
  });

  it('rejects missing capability and non-gateway readiness routes', () => {
    expect(() => resolveEnclaveGatewayContract(config(), {
      ...env(),
      AWF_ENCLAVE_MCP_CAPABILITY: undefined,
    })).toThrow(/CAPABILITY/);
    expect(() => resolveEnclaveGatewayContract(
      config(),
      env('http://127.0.0.1:8080/health'),
    )).toThrow(/must address the gateway route/);
  });

  it('rejects a missing gateway API key', () => {
    expect(() => resolveEnclaveGatewayContract(config(), {
      ...env(),
      MCP_GATEWAY_API_KEY: undefined,
    })).toThrow(/MCP_GATEWAY_API_KEY/);
  });

  it.each([
    [config(), { ...env(), AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'short' }, /IDENTITY/],
    [config(), { ...env(), AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: 'bad/name' }, /CONTAINER/],
    [config(), { ...env(), AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '999' }, /READINESS_TIMEOUT/],
    [config(), { ...env(), AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: 'not-a-url' }, /ENDPOINT/],
  ])('rejects invalid compiler handoff values', (wrapperConfig, handoff, expected) => {
    expect(() => resolveEnclaveGatewayContract(
      wrapperConfig,
      handoff as NodeJS.ProcessEnv,
    )).toThrow(expected as RegExp);
  });

  it('rejects compiler contract generation while enclaves are disabled', () => {
    expect(() => buildEnclaveMcpgUpstreamContract({
      ...config(),
      enclaves: undefined,
    })).toThrow(/disabled/);
  });

  it('rejects gateway resolution while enclaves are disabled', () => {
    expect(() => resolveEnclaveGatewayContract({
      ...config(),
      enclaves: undefined,
    }, env())).toThrow(/disabled/);
  });

  it('builds an agent-only timeout and tool allowlist', () => {
    const wrapperConfig = {
      ...config(),
      enclaves: normalizeEnclavesConfig([
        { agent: { model: 'gpt-test' }, repos: [repository], timeout: 45 },
      ]),
    };
    expect(buildEnclaveMcpgUpstreamContract(wrapperConfig).server).toMatchObject({
      tools: ['enclave_run_agent'],
      toolTimeout: 4860,
    });
  });

  it('attaches only the expected labelled gateway to the private control network', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          Name: '/awmg-mcpg',
          State: { Running: true },
          HostConfig: { NetworkMode: 'bridge' },
          Config: { Labels: { [ENCLAVE_MCP_GATEWAY_RUN_LABEL]: 'test-run-identity' } },
        }),
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          first: { Name: 'awf-enclave-mcp-server' },
          second: { Name: 'awmg-mcpg' },
        }),
      });
    await connectEnclaveGateway(config(), env());
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['network', 'connect', 'awf-enclave-mcp-control', 'awmg-mcpg'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('fails closed on gateway identity mismatch', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        Name: '/awmg-mcpg',
        State: { Running: true },
        HostConfig: { NetworkMode: 'bridge' },
        Config: { Labels: { [ENCLAVE_MCP_GATEWAY_RUN_LABEL]: 'wrong-run' } },
      }),
    });
    await expect(connectEnclaveGateway(config(), env())).rejects.toThrow(/identity did not match/);
  });

  it.each([
    [{ exitCode: 1, stdout: '', stderr: '' }, /container is unavailable/],
    [{ exitCode: 0, stdout: '{', stderr: '' }, /identity could not be inspected/],
  ])('fails closed when the gateway cannot be inspected', async (result, expected) => {
    mockExeca.mockResolvedValueOnce(result);
    await expect(connectEnclaveGateway(config(), env())).rejects.toThrow(expected);
  });

  it('fails closed when the gateway cannot attach to the control network', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          Name: '/awmg-mcpg',
          State: { Running: true },
          HostConfig: { NetworkMode: 'bridge' },
          Config: { Labels: { [ENCLAVE_MCP_GATEWAY_RUN_LABEL]: 'test-run-identity' } },
        }),
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'denied' });
    await expect(connectEnclaveGateway(config(), env())).rejects.toThrow(/Failed to attach/);
  });

  it.each([
    [{ exitCode: 1, stdout: '', stderr: '' }, /network is unavailable/],
    [{ exitCode: 0, stdout: '{', stderr: '' }, /membership could not be inspected/],
    [{
      exitCode: 0,
      stdout: JSON.stringify({
        first: { Name: 'awf-enclave-mcp-server' },
        second: { Name: 'awmg-mcpg' },
        third: { Name: 'unexpected' },
      }),
      stderr: '',
    }, /expected: awf-enclave-mcp-server, awmg-mcpg; actual: awf-enclave-mcp-server, awmg-mcpg, unexpected/],
  ])('fails closed on invalid control-network membership', async (networkResult, expected) => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          Name: '/awmg-mcpg',
          State: { Running: true },
          HostConfig: { NetworkMode: 'bridge' },
          Config: { Labels: { [ENCLAVE_MCP_GATEWAY_RUN_LABEL]: 'test-run-identity' } },
        }),
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(networkResult)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await expect(connectEnclaveGateway(config(), env())).rejects.toThrow(expected);
    expect(mockExeca).toHaveBeenNthCalledWith(
      4,
      'docker',
      ['network', 'disconnect', '-f', 'awf-enclave-mcp-control', 'awmg-mcpg'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('proves initialize and the exact tool contracts through the gateway', async () => {
    const contract = buildEnclaveMcpgUpstreamContract(config());
    const server = await listen([routedTool(enclaveProtocol.TOOL)]);
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000))
        .resolves.toBeUndefined();
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        stage: 'tools-list', readiness: 'ready', code: 'ready', attempts: 1,
      });
      expect(getEnclaveStartupProgress(wrapper)?.startupChecks).toMatchObject({
        ready: false, checks: {
          'gateway-handshake/contract': ['passed', 'none'],
          'gateway-handshake/initialize': ['passed', 'none'],
          'gateway-handshake/initialized': ['passed', 'none'],
          'gateway-handshake/tools-list': ['passed', 'none'],
        },
      });
      expect(contract.server.tools).toEqual(['enclave_run_script']);
      expect(server.authorizationHeaders()).toEqual([
        'g'.repeat(48),
        'g'.repeat(48),
        'g'.repeat(48),
      ]);
    } finally {
      await server.close();
    }
  });

  it('accepts bounded SSE responses from the gateway', async () => {
    const server = await listen([routedTool(enclaveProtocol.TOOL)], { sse: true });
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('rejects an initialize response outside the routed enclave endpoint', async () => {
    const server = await listen(
      [routedTool(enclaveProtocol.TOOL)],
      { serverName: 'awf-enclave' },
    );
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000))
        .rejects.toThrow(/routed AWF enclave server/);
      expect(getEnclaveStartupProgress(wrapper)?.code).toBe('identity-mismatch');
    } finally {
      await server.close();
    }
  });

  it('retries mcpg backend_unavailable responses until initialize succeeds', async () => {
    const server = await listen(
      [routedTool(enclaveProtocol.TOOL)],
      { unavailableInitializations: 1 },
    );
    try {
      const wrapper = config();
      const events: EnclaveStartupProgress[] = [];
      initializeEnclaveStartupProgress(wrapper, (event) => events.push(event));
      await expect(assertEnclaveGatewayReady(
        wrapper,
        {
          ...env(server.endpoint),
          AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '2000',
        },
      )).resolves.toBeUndefined();
      expect(server.initializeAttempts()).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        code: 'backend-unavailable', httpStatus: 503, attempts: 1,
      }));
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        readiness: 'ready', code: 'ready', attempts: 2,
      });
    } finally {
      await server.close();
    }
  });

  it('does not retry explicitly non-retryable backend_unavailable responses', async () => {
    const server = await listen(
      [],
      { unavailableInitializations: 1, unavailableRetryable: false },
    );
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .rejects.toThrow(/readiness request failed/);
      expect(server.initializeAttempts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('fails immediately when the gateway publishes a mismatched tool contract', async () => {
    const server = await listen([{ name: 'unexpected_tool' }]);
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000))
        .rejects.toThrow(/tool contract did not exactly match/);
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        stage: 'tools-list', code: 'tools-mismatch',
      });
      expect(server.initializeAttempts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('does not retry permanent HTTP failures', async () => {
    const server = await listen([], { initializationStatus: 401 });
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .rejects.toThrow(/readiness request failed/);
      expect(server.initializeAttempts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('does not retry a malformed backend-unavailable response', async () => {
    const server = await listen([], {
      initializationStatus: 503,
      initializationBody: '{',
    });
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .rejects.toThrow(/readiness request failed/);
      expect(server.initializeAttempts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('fails immediately on initialize JSON-RPC errors', async () => {
    const server = await listen([], { initializationRpcError: true });
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .rejects.toThrow(/initialize proof/);
      expect(server.initializeAttempts()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('rejects readiness responses above the framing bound', async () => {
    const server = await listen([], { oversizedInitialization: true });
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 1000))
        .rejects.toThrow(/framing bound/);
      expect(getEnclaveStartupProgress(wrapper)?.code).toBe('response-too-large');
    } finally {
      await server.close();
    }
  });

  it('caps each request by the remaining readiness deadline', async () => {
    const server = await listen([], { hangInitialization: true });
    const started = Date.now();
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 30))
        .rejects.toThrow(/request timed out/);
      expect(getEnclaveStartupProgress(wrapper)?.code).toBe('request-timeout');
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await server.close();
    }
  });

  it('enforces the deadline while a gateway slowly streams response bytes', async () => {
    const server = await listen([], { trickleInitialization: true });
    const started = Date.now();
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 30))
        .rejects.toThrow(/request timed out/);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await server.close();
    }
  });

  it('times out after retryable backend-unavailable responses exhaust the deadline', async () => {
    const server = await listen([], { unavailableInitializations: 100 });
    try {
      const wrapper = config();
      await expect(assertEnclaveGatewayReady(wrapper, env(server.endpoint), 30))
        .rejects.toThrow(/readiness timed out/);
      expect(getEnclaveStartupProgress(wrapper)).toMatchObject({
        readiness: 'attempted', code: 'readiness-deadline', httpStatus: 503, attempts: 1,
      });
    } finally {
      await server.close();
    }
  });

  it('covers canonical tool validation and an expired request budget', () => {
    expect(enclaveGatewayTestHelpers.canonicalToolSet('invalid')).toBe('invalid');
    expect(enclaveGatewayTestHelpers.canonicalJson(undefined)).toBe('undefined');
    expect(enclaveGatewayTestHelpers.canonicalToolSet([null])).toBe('invalid');
    expect(enclaveGatewayTestHelpers.canonicalToolSet([
      { name: 'duplicate' },
      { name: 'duplicate' },
    ])).toBe('invalid');
    expect(enclaveGatewayTestHelpers.canonicalToolSet([
      { name: 'z' },
      { name: 'a' },
    ])).toContain('"name":"a"');
    expect(() => enclaveGatewayTestHelpers.remainingRequestBudget(Date.now() - 1))
      .toThrow(/deadline expired/);
  });

  it('does not stop or disconnect anything when enclave cleanup is retained', async () => {
    await shutdownEnclaveGateway({ ...config(), enclaves: undefined }, env());
    await shutdownEnclaveGateway({ ...config(), keepContainers: true }, env());
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('drains the AWF server and disconnects mcpg without stopping the external container', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0|false|\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await shutdownEnclaveGateway(config(), env());
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['compose', 'stop', '-t', '4860', 'enclave-mcp-server'],
      expect.objectContaining({ cwd: '/tmp/awf-test', timeout: 4_875_000 }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      [
        'inspect',
        '--format={{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}',
        'awf-enclave-mcp-server',
      ],
      expect.anything(),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      3,
      'docker',
      ['network', 'disconnect', '-f', 'awf-enclave-mcp-control', 'awmg-mcpg'],
      expect.anything(),
    );
    expect(mockExeca.mock.calls.flat().join(' ')).not.toMatch(/docker (?:stop|rm).*awmg-mcpg/);
  });

  it('does not disconnect mcpg when the enclave server fails to drain', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'failed' });
    await expect(shutdownEnclaveGateway(config(), env())).rejects.toThrow(/Failed to drain/);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('reports enclave server OOM state after an abnormal shutdown', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '137|true|\n', stderr: '' });
    await expect(shutdownEnclaveGateway(config(), env()))
      .rejects.toThrow(/137\|true\|/);
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });
});
