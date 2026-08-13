import type { WrapperConfig } from '../types';
import { buildAgentCredentialEnv } from '../services/api-proxy-credential-env';
import { buildAgentEnvironment } from '../services/agent-service';
import { buildGuestEnvironment } from './guest-environment';

jest.mock('../services/agent-service', () => ({
  buildAgentEnvironment: jest.fn(),
}));

jest.mock('../services/api-proxy-credential-env', () => ({
  buildAgentCredentialEnv: jest.fn(),
}));

const mockBuildAgentEnvironment = buildAgentEnvironment as jest.MockedFunction<
  typeof buildAgentEnvironment
>;
const mockBuildAgentCredentialEnv = buildAgentCredentialEnv as jest.MockedFunction<
  typeof buildAgentCredentialEnv
>;

function buildEnvironment(config: Partial<WrapperConfig> = {}): Record<string, string> {
  return buildGuestEnvironment({
    config: config as WrapperConfig,
    networkConfig: {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '100.64.0.2',
      proxyIp: '172.30.0.30',
    },
    home: '/workspace/.awf-home',
    workspace: '/workspace',
    runtimeName: 'test-runtime',
    runtimeDisplayName: 'Test Runtime',
  });
}

describe('buildGuestEnvironment', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockBuildAgentEnvironment.mockReturnValue({ BASE: 'value' });
  });

  it('adds canonical guest metadata, proxy settings, and API proxy credentials', () => {
    mockBuildAgentCredentialEnv.mockReturnValue({ AWF_API_PROXY_IP: '172.30.0.30' });

    const environment = buildEnvironment({ enableApiProxy: true });

    expect(environment).toMatchObject({
      BASE: 'value',
      AWF_API_PROXY_IP: '172.30.0.30',
      HOME: '/workspace/.awf-home',
      PWD: '/workspace',
      AWF_WORKDIR: '/workspace',
      SQUID_PROXY_HOST: '172.30.0.10',
      HOSTNAME: 'awf-test-runtime',
      AWF_RUNTIME: 'test-runtime',
      http_proxy: 'http://172.30.0.10:3128',
    });
    expect(mockBuildAgentCredentialEnv).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider credential in the guest environment', () => {
    mockBuildAgentEnvironment.mockReturnValue({ LEAKED: 'secret' });

    expect(() => buildEnvironment({ openaiApiKey: 'secret' }))
      .toThrow('Refusing to pass a real provider credential through Test Runtime guest variable LEAKED');
  });
});
