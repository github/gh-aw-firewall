import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_GITHUB_PROXY_RUN_LABEL,
  connectEnclaveGithubGateway,
  disconnectEnclaveGithubGateway,
  enclaveGithubGatewayTestHelpers,
  resolveEnclaveGithubGatewayContract,
  shutdownEnclaveGithubCliProxy,
} from './github-gateway';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

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

function network(members = ['awf-enclave-agent-cli-proxy', 'compiler-mcpg']): string {
  return JSON.stringify({
    Internal: true,
    Driver: 'bridge',
    IPAM: { Config: [{ Subnet: '172.29.0.0/24' }] },
    Containers: Object.fromEntries(members.map((Name, index) => [String(index), { Name }])),
  });
}

function attachedProxy(aliases = ['compiler-mcpg', 'awf-enclave-github-proxy']): string {
  return JSON.stringify({
    NetworkSettings: {
      Networks: {
        'awf-enclave-github-control': { Aliases: aliases },
      },
    },
  });
}

describe('enclave GitHub gateway handoff', () => {
  let directory: string;
  let caCertPath: string;
  let handoff: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockExeca.mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-gateway-'));
    caCertPath = path.join(directory, 'ca.crt');
    fs.writeFileSync(caCertPath, 'test-ca', { mode: 0o600 });
    handoff = {
      AWF_ENCLAVE_GITHUB_PROXY_CONTAINER: 'compiler-mcpg',
      AWF_ENCLAVE_GITHUB_PROXY_IDENTITY: 'gh-aw-egh-123456-1-abcdef123456',
      AWF_ENCLAVE_GITHUB_PROXY_CA_CERT: caCertPath,
    };
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts only the fixed compiler handoff fields', () => {
    expect(resolveEnclaveGithubGatewayContract(enabledConfig(), handoff)).toEqual({
      containerName: 'compiler-mcpg',
      identity: 'gh-aw-egh-123456-1-abcdef123456',
      caCertPath,
    });
    for (const name of Object.keys(handoff)) {
      expect(() => resolveEnclaveGithubGatewayContract(
        enabledConfig(),
        { ...handoff, [name]: undefined },
      )).toThrow();
    }
    expect(() => resolveEnclaveGithubGatewayContract(
      enabledConfig(),
      { ...handoff, AWF_ENCLAVE_GITHUB_PROXY_IDENTITY: 'job_with_underscores' },
    )).toThrow(/canonical compiler capability run identity/);
  });

  it('verifies identity before attaching the external proxy', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          Name: '/compiler-mcpg',
          State: { Running: true },
          Config: { Labels: { [ENCLAVE_GITHUB_PROXY_RUN_LABEL]: 'gh-aw-egh-123456-1-abcdef123456' } },
          HostConfig: { NetworkMode: 'bridge' },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: network(), stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: attachedProxy(), stderr: '' });

    await connectEnclaveGithubGateway(enabledConfig(), handoff);

    expect(mockExeca.mock.calls[1][1]).toEqual([
      'network',
      'connect',
      '--alias',
      'awf-enclave-github-proxy',
      'awf-enclave-github-control',
      'compiler-mcpg',
    ]);
  });

  it.each([
    network(['awf-enclave-agent-cli-proxy']),
    network(['awf-enclave-agent-cli-proxy', 'compiler-mcpg', 'unexpected']),
    JSON.stringify({
      Internal: false,
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.29.0.0/24' }] },
      Containers: {},
    }),
  ])('rejects an inexact control topology', async (inspection) => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: inspection, stderr: '' });
    await expect(
      enclaveGithubGatewayTestHelpers.assertControlNetworkMembership({
        containerName: 'compiler-mcpg',
        identity: 'gh-aw-egh-123456-1-abcdef123456',
        caCertPath,
      }),
    ).rejects.toThrow(/unexpected member|fixed isolated bridge/);
  });

  it('rejects an external proxy attachment without the fixed private alias', async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: attachedProxy(['compiler-mcpg']),
      stderr: '',
    });
    await expect(
      enclaveGithubGatewayTestHelpers.assertExternalProxyAlias({
        containerName: 'compiler-mcpg',
        identity: 'gh-aw-egh-123456-1-abcdef123456',
        caCertPath,
      }),
    ).rejects.toThrow(/fixed private alias/);
  });

  it('stops the PAT-free CLI proxy before audit preservation', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await shutdownEnclaveGithubCliProxy(enabledConfig());
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['stop', '--time', '5', 'awf-enclave-agent-cli-proxy'],
      expect.any(Object),
    );
  });

  it('fails cleanup when the compiler proxy cannot be disconnected', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'disconnect failed' });
    await expect(
      disconnectEnclaveGithubGateway(enabledConfig(), handoff),
    ).rejects.toThrow(/Failed to disconnect/);
  });
});
