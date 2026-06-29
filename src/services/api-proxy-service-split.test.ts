import * as path from 'path';
import { parseImageTag } from '../image-tag';
import { COPILOT_PLACEHOLDER_TOKEN } from '../constants/placeholders';
import { baseConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import { buildApiProxyServiceConfig } from './api-proxy-service-config';
import { buildApiProxyBaseEnv, buildProviderTargetEnv } from './api-proxy-env-config';
import { buildApiProxyLifecycleConfig } from './api-proxy-lifecycle-config';
import { buildAgentCredentialEnv } from './api-proxy-credential-env';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

describe('API proxy split builders', () => {
  const networkConfig = {
    subnet: '172.30.0.0/24',
    squidIp: '172.30.0.10',
    agentIp: '172.30.0.20',
    proxyIp: '172.30.0.30',
  };

  const imageConfig = {
    useGHCR: true,
    registry: 'ghcr.io/github/gh-aw-firewall',
    parsedTag: parseImageTag('latest'),
    projectRoot: path.join(__dirname, '..', '..'),
  };

  it('buildApiProxyServiceConfig builds sidecar service spec', () => {
    const service = buildApiProxyServiceConfig({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        openaiApiKey: 'sk-test-openai-key',
      },
      networkConfig,
      apiProxyLogsPath: '/tmp/awf-test/logs/api-proxy',
      imageConfig,
    });

    expect(service.container_name).toBe('awf-api-proxy');
    expect(service.environment.OPENAI_API_KEY).toBe('sk-test-openai-key');
    expect(service.environment.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(service.image).toBe('ghcr.io/github/gh-aw-firewall/api-proxy:latest');
  });

  it('buildApiProxyBaseEnv builds proxy routing and key env', () => {
    const env = buildApiProxyBaseEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      openaiApiKey: 'sk-test-openai-key',
      copilotApiTarget: 'https://api.githubcopilot.com',
    }, networkConfig);

    expect(env.OPENAI_API_KEY).toBe('sk-test-openai-key');
    expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.COPILOT_API_TARGET).toBe('api.githubcopilot.com');
  });

  it('buildApiProxyLifecycleConfig builds network and healthcheck', () => {
    const lifecycle = buildApiProxyLifecycleConfig(networkConfig);
    expect(lifecycle.networks['awf-net'].ipv4_address).toBe('172.30.0.30');
    expect(lifecycle.healthcheck.test).toEqual(['CMD', 'curl', '-f', 'http://localhost:10000/health']);
  });

  it('buildApiProxyLifecycleConfig throws when proxyIp is missing', () => {
    expect(() => buildApiProxyLifecycleConfig({ ...networkConfig, proxyIp: undefined }))
      .toThrow('buildApiProxyLifecycleConfig: networkConfig.proxyIp is required');
  });

  it('buildApiProxyBaseEnv trims explicit provider session id', () => {
    const env = buildApiProxyBaseEnv({
      ...baseConfig,
      workDir: '/tmp/awf-test',
      copilotByokSessionId: ' session-123 ',
    }, networkConfig);

    expect(env.AWF_PROVIDER_SESSION_ID).toBe('session-123');
  });

  it('buildProviderTargetEnv trims AWF_PROVIDER_SESSION_ID from process.env', () => {
    const savedSessionId = process.env.AWF_PROVIDER_SESSION_ID;
    process.env.AWF_PROVIDER_SESSION_ID = ' session-from-env ';

    try {
      const env = buildProviderTargetEnv({
        ...baseConfig,
        workDir: '/tmp/awf-test',
      });

      expect(env.AWF_PROVIDER_SESSION_ID).toBe('session-from-env');
    } finally {
      if (savedSessionId !== undefined) process.env.AWF_PROVIDER_SESSION_ID = savedSessionId;
      else delete process.env.AWF_PROVIDER_SESSION_ID;
    }
  });

  it('buildAgentCredentialEnv builds isolated agent credentials', () => {
    const agentEnvAdditions = buildAgentCredentialEnv({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        openaiApiKey: 'sk-test-openai-key',
        copilotGithubToken: 'ghu_test_token',
        additionalEnv: {
          COPILOT_MODEL: 'gpt-5',
        },
      },
      networkConfig,
    });

    expect(agentEnvAdditions.AWF_API_PROXY_IP).toBe('172.30.0.30');
    expect(agentEnvAdditions.OPENAI_BASE_URL).toBe('http://172.30.0.30:10000');
    expect(agentEnvAdditions.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
    expect(agentEnvAdditions.CODEX_API_KEY).toBe('sk-placeholder-for-api-proxy');
    expect(agentEnvAdditions.COPILOT_API_URL).toBe('http://172.30.0.30:10002');
    expect(agentEnvAdditions.COPILOT_TOKEN).toBe(COPILOT_PLACEHOLDER_TOKEN);
    expect(agentEnvAdditions.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('buildApiProxyServiceConfig throws when proxyIp is missing', () => {
    const networkConfigWithoutProxyIp = { ...networkConfig, proxyIp: undefined };

    expect(() => buildApiProxyServiceConfig({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        openaiApiKey: 'sk-test-openai-key',
      },
      networkConfig: networkConfigWithoutProxyIp,
      apiProxyLogsPath: '/tmp/awf-test/logs/api-proxy',
      imageConfig,
    })).toThrow('buildApiProxyServiceConfig: networkConfig.proxyIp is required');
  });

  it('buildAgentCredentialEnv throws when proxyIp is missing', () => {
    const networkConfigWithoutProxyIp = { ...networkConfig, proxyIp: undefined };

    expect(() => buildAgentCredentialEnv({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        openaiApiKey: 'sk-test-openai-key',
      },
      networkConfig: networkConfigWithoutProxyIp,
    })).toThrow('buildAgentCredentialEnv: networkConfig.proxyIp is required');
  });

  it('buildAgentCredentialEnv sets ANTHROPIC_AUTH_TOKEN placeholder when anthropicApiKey is present', () => {
    const agentEnvAdditions = buildAgentCredentialEnv({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        anthropicApiKey: 'sk-ant-real-key',
      },
      networkConfig,
    });

    expect(agentEnvAdditions.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
    // ANTHROPIC_API_KEY must NOT be in agentEnvAdditions — it is excluded via excluded-vars.ts
    expect(agentEnvAdditions.ANTHROPIC_API_KEY).toBeUndefined();
    expect(agentEnvAdditions.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
    expect(agentEnvAdditions.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
  });

  it('buildAgentCredentialEnv sets ANTHROPIC_AUTH_TOKEN placeholder for WIF auth (no static key)', () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
    };
    try {
      const agentEnvAdditions = buildAgentCredentialEnv({
        config: {
          ...baseConfig,
          workDir: '/tmp/awf-test',
          enableApiProxy: true,
          // No anthropicApiKey — WIF-only path
        },
        networkConfig,
      });

      expect(agentEnvAdditions.ANTHROPIC_BASE_URL).toBe('http://172.30.0.30:10001');
      // ANTHROPIC_API_KEY must NOT be in agentEnvAdditions — excluded-vars.ts handles removal
      expect(agentEnvAdditions.ANTHROPIC_API_KEY).toBeUndefined();
      expect(agentEnvAdditions.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-placeholder-key-for-credential-isolation');
    } finally {
      process.env = originalEnv;
    }
  });

  it('buildAgentCredentialEnv sets Gemini proxy URLs and placeholder key when geminiApiKey is present', () => {
    const agentEnvAdditions = buildAgentCredentialEnv({
      config: {
        ...baseConfig,
        workDir: '/tmp/awf-test',
        enableApiProxy: true,
        geminiApiKey: 'gemini-real-key',
      },
      networkConfig,
    });

    expect(agentEnvAdditions.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.30:10003');
    expect(agentEnvAdditions.GEMINI_API_BASE_URL).toBe('http://172.30.0.30:10003');
    expect(agentEnvAdditions.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
  });
});
