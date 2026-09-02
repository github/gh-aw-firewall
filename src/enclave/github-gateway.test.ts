import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
  assertEnclaveGithubGatewayReady,
  connectEnclaveGithubGateway,
  disconnectEnclaveGithubGateway,
  enclaveGithubGatewayTestHelpers,
  resolveEnclaveGithubGatewayContract,
} from './github-gateway';
import { resolveEnclavePaths } from './paths';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

const AGENT_ID = 'enclaveAgentId0123456789abcdef012345';

function enabledConfig(): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    enclaves: normalizeEnclavesConfig([{
      agent: {
        model: 'gpt-test',
        github: { cli: 'issues-read-v1' },
      },
      repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
    }]),
  } as WrapperConfig;
}

function handoff(): NodeJS.ProcessEnv {
  return {
    AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: 'awmg-mcpg',
    AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: 'http://localhost:8080/mcp/awf-enclave',
    AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'gh-aw-123456-1-job',
    [ENCLAVE_GITHUB_MCP_AGENT_ID_ENV]: AGENT_ID,
  };
}

async function withGatewayServer(
  handler: http.RequestListener,
  task: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test gateway did not bind TCP');
    await task(`http://127.0.0.1:${address.port}/mcp/awf-enclave`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (
      error ? reject(error) : resolve()
    )));
  }
}

function network(members = ['awf-enclave-agent-api-proxy', 'awmg-mcpg']): string {
  return JSON.stringify({
    Internal: true,
    Driver: 'bridge',
    IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] },
    Containers: Object.fromEntries(members.map((Name, index) => [String(index), { Name }])),
  });
}

function attachedGateway(
  aliases = ['awmg-mcpg', 'awf-enclave-github-mcp'],
  ipAddress = '172.31.0.40',
): string {
  return JSON.stringify({
    NetworkSettings: {
      Networks: {
        'awf-enclave-agent': { Aliases: aliases, IPAddress: ipAddress },
      },
    },
  });
}

describe('direct enclave GitHub MCP handoff', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('derives the GitHub route from the shared gateway contract', () => {
    const contract = resolveEnclaveGithubGatewayContract(enabledConfig(), handoff());
    expect(contract).toMatchObject({
      agentId: AGENT_ID,
      containerName: 'awmg-mcpg',
      identity: 'gh-aw-123456-1-job',
    });
    expect(contract.endpoint.href).toBe('http://localhost:8080/mcp/github');
  });

  it.each([
    'AWF_ENCLAVE_MCP_GATEWAY_CONTAINER',
    'AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT',
    'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY',
    ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
  ])('requires compiler handoff field %s', (name) => {
    expect(() => resolveEnclaveGithubGatewayContract(
      enabledConfig(),
      { ...handoff(), [name]: undefined },
    )).toThrow();
  });

  it('resolves the scrubbed agent identity from private staged state', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-agent-id-'));
    const config = { ...enabledConfig(), workDir };
    const paths = resolveEnclavePaths(workDir);
    try {
      fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(paths.githubAgentIdPath, `${AGENT_ID}\n`, { mode: 0o600 });
      expect(resolveEnclaveGithubGatewayContract(config, {
        ...handoff(),
        [ENCLAVE_GITHUB_MCP_AGENT_ID_ENV]: undefined,
      }).agentId).toBe(AGENT_ID);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it('attaches shared mcpg directly to the enclave network', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          Name: '/awmg-mcpg',
          State: { Running: true },
          Config: { Labels: { 'com.github.gh-aw.mcpg.run': 'gh-aw-123456-1-job' } },
          HostConfig: { NetworkMode: 'bridge' },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: network(), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: attachedGateway(), stderr: '' });

    await connectEnclaveGithubGateway(enabledConfig(), handoff());

    expect(mockExeca.mock.calls[1][1]).toEqual([
      'network',
      'connect',
      '--ip',
      '172.31.0.40',
      '--alias',
      'awf-enclave-github-mcp',
      'awf-enclave-agent',
      'awmg-mcpg',
    ]);
  });

  it.each([
    network(['awf-enclave-agent-api-proxy']),
    network(['awf-enclave-agent-api-proxy', 'awmg-mcpg', 'unexpected']),
    JSON.stringify({
      Internal: false,
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] },
      Containers: {},
    }),
  ])('rejects an inexact enclave network topology', async (inspection) => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: inspection, stderr: '' });
    await expect(
      enclaveGithubGatewayTestHelpers.assertAgentNetworkMembership(
        resolveEnclaveGithubGatewayContract(enabledConfig(), handoff()),
      ),
    ).rejects.toThrow(/unexpected steady-state member|fixed isolated bridge/);
  });

  it('rejects a shared gateway attachment without the fixed alias and address', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: attachedGateway(['awmg-mcpg'], '172.31.0.41'),
      stderr: '',
    });
    await expect(
      enclaveGithubGatewayTestHelpers.assertSharedGatewayAttachment(
        resolveEnclaveGithubGatewayContract(enabledConfig(), handoff()),
      ),
    ).rejects.toThrow(/fixed enclave attachment/);
  });

  it('disconnects only the shared gateway from the enclave network', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await disconnectEnclaveGithubGateway(enabledConfig(), handoff());
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['network', 'disconnect', '-f', 'awf-enclave-agent', 'awmg-mcpg'],
      expect.any(Object),
    );
  });

  it('initializes a session and proves the exact direct GitHub tool set', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: network(), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: attachedGateway(), stderr: '' });
    const methods: string[] = [];
    await withGatewayServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        expect(request.headers.authorization).toBe(AGENT_ID);
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        methods.push(message.method);
        if (message.method === 'initialize') {
          response.setHeader('Mcp-Session-Id', 'session-1');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        } else if (message.method === 'notifications/initialized') {
          expect(request.headers['mcp-session-id']).toBe('session-1');
          response.statusCode = 202;
          response.end();
        } else {
          expect(request.headers['mcp-session-id']).toBe('session-1');
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'list_issues' }, { name: 'issue_read' }] },
          }));
        }
      });
    }, async endpoint => {
      await expect(assertEnclaveGithubGatewayReady(enabledConfig(), {
        ...handoff(),
        AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
      }, 2_000)).resolves.toBeUndefined();
    });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('rejects an identity failure before listing tools', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: network(), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: attachedGateway(), stderr: '' });
    await withGatewayServer((_request, response) => {
      response.statusCode = 401;
      response.end();
    }, async endpoint => {
      await expect(assertEnclaveGithubGatewayReady(enabledConfig(), {
        ...handoff(),
        AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
      }, 2_000)).rejects.toThrow(/request failed/);
    });
  });

  it('rejects any tool beyond the issues-read-v1 profile', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: network(), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: attachedGateway(), stderr: '' });
    await withGatewayServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (message.method === 'initialize') {
          response.setHeader('Mcp-Session-Id', 'session-2');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        } else if (message.method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
        } else {
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [{ name: 'list_issues' }, { name: 'issue_read' }, { name: 'search_code' }],
            },
          }));
        }
      });
    }, async endpoint => {
      await expect(assertEnclaveGithubGatewayReady(enabledConfig(), {
        ...handoff(),
        AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
      }, 2_000)).rejects.toThrow(/exactly the issues-read-v1 tools/);
    });
  });
});
