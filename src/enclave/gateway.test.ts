import * as http from 'http';
import * as path from 'path';
import execa from 'execa';
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
  '../../containers/bounded-query/enclave-mcp/mcp-protocol.js',
));

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

function config(agent = false): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        script: { enabled: true },
        agent: agent ? { enabled: true, model: 'gpt-test' } : undefined,
      },
    }),
  } as WrapperConfig;
}

function env(endpoint = 'http://127.0.0.1:8080/mcp/awf-enclave'): NodeJS.ProcessEnv {
  return {
    AWF_ENCLAVE_MCP_CAPABILITY: 'a'.repeat(64),
    AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'test-run-identity',
    AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: 'awmg-mcpg',
    AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
  };
}

function listen(
  tools: unknown[],
  unavailableInitializations = 0,
): Promise<{
  endpoint: string;
  initializeAttempts: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let initializeAttempts = 0;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number;
          method: string;
        };
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'session-1');
        if (message.method === 'initialize') {
          initializeAttempts += 1;
          if (initializeAttempts <= unavailableInitializations) {
            response.statusCode = 503;
            response.end(JSON.stringify({
              error: 'backend_unavailable',
              message: 'Backend MCP server is not ready; retry initialization',
              retryable: true,
            }));
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
              serverInfo: { name: 'awf-enclave', version: '1.0.0' },
            }
          : { tools };
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolve({
        endpoint: `http://127.0.0.1:${address.port}/mcp/awf-enclave`,
        initializeAttempts: () => initializeAttempts,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('enclave mcpg handoff', () => {
  beforeEach(() => mockExeca.mockReset());

  it('generates the exact static compiler upstream without secret material', () => {
    expect(buildEnclaveMcpgUpstreamContract(config(true))).toEqual({
      name: 'awf-enclave',
      server: {
        type: 'http',
        url: 'http://awf-enclave-mcp:8080/mcp',
        headers: { Authorization: 'Bearer ${AWF_ENCLAVE_MCP_CAPABILITY}' },
        tools: ['enclave_run_script', 'enclave_run_agent'],
        connectTimeout: 120,
        toolTimeout: 150,
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

  it('proves initialize and the exact tool contracts through the gateway', async () => {
    const contract = buildEnclaveMcpgUpstreamContract(config());
    const server = await listen([{
      name: 'enclave_run_script',
      description: 'Run a bounded script against one configured private repository and return one finite value.',
      inputSchema: {
        type: 'object',
        properties: {
          privateRepo: { type: 'string', description: 'Bare configured owner/repository selector.' },
          schema: {
            type: 'object',
            description: 'An AWF finite-disclosure schema (const, boolean, enum, integer, object, tuple, array, or union).',
          },
          script: { type: 'string', description: 'Bounded UTF-8 Python source.' },
        },
        required: ['privateRepo', 'schema', 'script'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { status: { enum: ['ok', 'error'] }, result: {} },
        required: ['status'],
        additionalProperties: false,
      },
    }]);
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 1000))
        .resolves.toBeUndefined();
      expect(contract.server.tools).toEqual(['enclave_run_script']);
    } finally {
      await server.close();
    }
  });

  it('retries mcpg backend_unavailable responses until initialize succeeds', async () => {
    const server = await listen([enclaveProtocol.TOOL], 1);
    try {
      await expect(assertEnclaveGatewayReady(
        config(),
        {
          ...env(server.endpoint),
          AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '2000',
        },
      )).resolves.toBeUndefined();
      expect(server.initializeAttempts()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('times out before agent startup when the gateway publishes a mismatched tool contract', async () => {
    const server = await listen([{ name: 'unexpected_tool' }]);
    try {
      await expect(assertEnclaveGatewayReady(config(), env(server.endpoint), 10))
        .rejects.toThrow(/tool contract did not exactly match/);
    } finally {
      await server.close();
    }
  });

  it('drains the AWF server and disconnects mcpg without stopping the external container', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await shutdownEnclaveGateway(config(), env());
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['compose', 'stop', '-t', '10', 'enclave-mcp-server'],
      expect.objectContaining({ cwd: '/tmp/awf-test' }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['network', 'disconnect', '-f', 'awf-enclave-mcp-control', 'awmg-mcpg'],
      expect.anything(),
    );
    expect(mockExeca.mock.calls.flat().join(' ')).not.toMatch(/docker (?:stop|rm).*awmg-mcpg/);
  });
});
