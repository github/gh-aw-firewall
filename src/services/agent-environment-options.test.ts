import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent environment: options', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

  it('should forward DOCKER_HOST into agent container when set (TCP address)', () => {
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://localhost:2375';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      // Agent must receive the original DOCKER_HOST so it can reach the DinD daemon
      expect(env.DOCKER_HOST).toBe('tcp://localhost:2375');
    } finally {
      if (originalDockerHost !== undefined) {
        process.env.DOCKER_HOST = originalDockerHost;
      } else {
        delete process.env.DOCKER_HOST;
      }
    }
  });

  it('should forward DOCKER_HOST into agent container when set (unix socket)', () => {
    const originalDockerHost = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    } finally {
      if (originalDockerHost !== undefined) {
        process.env.DOCKER_HOST = originalDockerHost;
      } else {
        delete process.env.DOCKER_HOST;
      }
    }
  });

  it('should not set DOCKER_HOST in agent container when not in host environment', () => {
    const originalDockerHost = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.DOCKER_HOST).toBeUndefined();
    } finally {
      if (originalDockerHost !== undefined) {
        process.env.DOCKER_HOST = originalDockerHost;
      }
    }
  });

  it('should add additional environment variables from config', () => {
    const configWithEnv = {
      ...mockConfig,
      additionalEnv: {
        CUSTOM_VAR: 'custom_value',
        ANOTHER_VAR: 'another_value',
      },
    };
    const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.CUSTOM_VAR).toBe('custom_value');
    expect(env.ANOTHER_VAR).toBe('another_value');
  });

  it('should exclude system variables when envAll is enabled', () => {
    const originalPath = process.env.PATH;
    const originalCustomHostVar = process.env.CUSTOM_HOST_VAR;
    process.env.CUSTOM_HOST_VAR = 'test_value';

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      // Should NOT pass through excluded vars
      expect(env.PATH).not.toBe(originalPath);
      expect(env.PATH).toBe('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');

      // Should pass through non-excluded vars
      expect(env.CUSTOM_HOST_VAR).toBe('test_value');
    } finally {
      if (originalCustomHostVar !== undefined) process.env.CUSTOM_HOST_VAR = originalCustomHostVar;
      else delete process.env.CUSTOM_HOST_VAR;
    }
  });

  it('should exclude specified variables when excludeEnv is set with envAll', () => {
    const originalCustomHostVar = process.env.CUSTOM_HOST_VAR;
    const originalSecretToken = process.env.SECRET_TOKEN;
    process.env.CUSTOM_HOST_VAR = 'test_value';
    process.env.SECRET_TOKEN = 'super-secret';

    try {
      const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['SECRET_TOKEN'] };
      const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // Should pass through non-excluded vars
      expect(env.CUSTOM_HOST_VAR).toBe('test_value');
      // Should NOT pass through excluded var
      expect(env.SECRET_TOKEN).toBeUndefined();
    } finally {
      if (originalCustomHostVar !== undefined) process.env.CUSTOM_HOST_VAR = originalCustomHostVar;
      else delete process.env.CUSTOM_HOST_VAR;
      if (originalSecretToken !== undefined) process.env.SECRET_TOKEN = originalSecretToken;
      else delete process.env.SECRET_TOKEN;
    }
  });

  it('should exclude multiple variables when excludeEnv contains multiple names', () => {
    const originalTokenA = process.env.TOKEN_A;
    const originalTokenB = process.env.TOKEN_B;
    const originalSafeVar = process.env.SAFE_VAR;
    process.env.TOKEN_A = 'value-a';
    process.env.TOKEN_B = 'value-b';
    process.env.SAFE_VAR = 'safe';

    try {
      const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['TOKEN_A', 'TOKEN_B'] };
      const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.TOKEN_A).toBeUndefined();
      expect(env.TOKEN_B).toBeUndefined();
      expect(env.SAFE_VAR).toBe('safe');
    } finally {
      if (originalTokenA !== undefined) process.env.TOKEN_A = originalTokenA;
      else delete process.env.TOKEN_A;
      if (originalTokenB !== undefined) process.env.TOKEN_B = originalTokenB;
      else delete process.env.TOKEN_B;
      if (originalSafeVar !== undefined) process.env.SAFE_VAR = originalSafeVar;
      else delete process.env.SAFE_VAR;
    }
  });

  it('should have no effect when excludeEnv is set but envAll is false', () => {
    const originalSecretToken = process.env.SECRET_TOKEN;
    process.env.SECRET_TOKEN = 'super-secret';

    try {
      const configWithExcludeEnv = { ...mockConfig, envAll: false, excludeEnv: ['SECRET_TOKEN'] };
      const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // envAll is false so SECRET_TOKEN was never going to be injected anyway
      expect(env.SECRET_TOKEN).toBeUndefined();
    } finally {
      if (originalSecretToken !== undefined) process.env.SECRET_TOKEN = originalSecretToken;
      else delete process.env.SECRET_TOKEN;
    }
  });

  it('should exclude host proxy env vars from env-all passthrough to prevent routing conflicts', () => {
    const saved: Record<string, string | undefined> = {};
    const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

    for (const v of proxyVars) {
      saved[v] = process.env[v];
      process.env[v] = `http://host-proxy.corp.com:3128`;
    }

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // Host proxy vars must not leak — AWF sets its own proxy vars pointing to Squid
      for (const v of proxyVars) {
        // The value should either be absent or overwritten to Squid's address
        if (env[v] !== undefined) {
          expect(env[v]).not.toBe('http://host-proxy.corp.com:3128');
        }
      }
    } finally {
      for (const v of proxyVars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
        else delete process.env[v];
      }
    }
  });

  it('should skip env vars exceeding MAX_ENV_VALUE_SIZE from env-all passthrough', () => {
    const largeVarName = 'AWF_TEST_OVERSIZED_VAR';
    const saved = process.env[largeVarName];
    // Create a value larger than 64KB
    process.env[largeVarName] = 'x'.repeat(65 * 1024);

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // Oversized var should be skipped
      expect(env[largeVarName]).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env[largeVarName] = saved;
      else delete process.env[largeVarName];
    }
  });

  it('should pass env vars under MAX_ENV_VALUE_SIZE from env-all passthrough', () => {
    const normalVarName = 'AWF_TEST_NORMAL_VAR';
    const saved = process.env[normalVarName];
    process.env[normalVarName] = 'normal_value';

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env[normalVarName]).toBe('normal_value');
    } finally {
      if (saved !== undefined) process.env[normalVarName] = saved;
      else delete process.env[normalVarName];
    }
  });

  it('should auto-inject GH_HOST from GITHUB_SERVER_URL when envAll is true', () => {
    const prevServerUrl = process.env.GITHUB_SERVER_URL;
    const prevGhHost = process.env.GH_HOST;
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
    delete process.env.GH_HOST;

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.GH_HOST).toBe('mycompany.ghe.com');
    } finally {
      if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
      else delete process.env.GITHUB_SERVER_URL;
      if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
    }
  });

  it('should override proxy-rewritten GH_HOST from env-all with GITHUB_SERVER_URL-derived value', () => {
    const prevServerUrl = process.env.GITHUB_SERVER_URL;
    const prevGhHost = process.env.GH_HOST;
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
    process.env.GH_HOST = 'localhost:18443'; // proxy-rewritten value

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // GH_HOST should be derived from GITHUB_SERVER_URL, not the proxy value
      expect(env.GH_HOST).toBe('mycompany.ghe.com');
    } finally {
      if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
      else delete process.env.GITHUB_SERVER_URL;
      if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
      else delete process.env.GH_HOST;
    }
  });

  it('should remove proxy-rewritten GH_HOST on github.com', () => {
    const prevServerUrl = process.env.GITHUB_SERVER_URL;
    const prevGhHost = process.env.GH_HOST;
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GH_HOST = 'localhost:18443'; // proxy-rewritten value

    try {
      const configWithEnvAll = { ...mockConfig, envAll: true };
      const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // GH_HOST should be removed — gh CLI defaults to github.com
      expect(env.GH_HOST).toBeUndefined();
    } finally {
      if (prevServerUrl !== undefined) process.env.GITHUB_SERVER_URL = prevServerUrl;
      else delete process.env.GITHUB_SERVER_URL;
      if (prevGhHost !== undefined) process.env.GH_HOST = prevGhHost;
      else delete process.env.GH_HOST;
    }
  });

  describe('envFile option', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-envfile-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should inject variables from env file into agent environment', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'MY_CUSTOM_VAR=hello\nANOTHER_VAR=world\n');

      const config = { ...mockConfig, envFile };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.MY_CUSTOM_VAR).toBe('hello');
      expect(env.ANOTHER_VAR).toBe('world');
    });

    it('should allow --env flags to override env-file values', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'MY_VAR=from_file\n');

      const config = { ...mockConfig, envFile, additionalEnv: { MY_VAR: 'from_flag' } };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.MY_VAR).toBe('from_flag');
    });

    it('should not overwrite already-set env vars with env-file values', () => {
      const envFile = path.join(tmpDir, '.env');
      // AWF_DNS_SERVERS is set before envFile processing; file should not clobber it
      fs.writeFileSync(envFile, 'AWF_DNS_SERVERS=1.1.1.1\n');

      const config = { ...mockConfig, envFile };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // AWF_DNS_SERVERS is set by the framework; file should NOT override it
      expect(env.AWF_DNS_SERVERS).not.toBe('1.1.1.1');
    });

    it('should skip excluded system vars from env file', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'PATH=/evil/path\nHOME=/evil/home\nMY_VAR=ok\n');

      const config = { ...mockConfig, envFile };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.PATH).not.toBe('/evil/path');
      expect(env.HOME).not.toBe('/evil/home');
      expect(env.MY_VAR).toBe('ok');
    });

    it('should skip comment lines and blank lines in env file', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, '# comment\n\nFOO=bar\n');

      const config = { ...mockConfig, envFile };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.FOO).toBe('bar');
    });
  });

  it('should configure DNS to use Google DNS', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;

    expect(agent.dns).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(agent.dns_search).toEqual([]);
  });

  it('should NOT configure extra_hosts by default (opt-in for security)', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const squid = result.services['squid-proxy'];

    expect(agent.extra_hosts).toBeUndefined();
    expect(squid.extra_hosts).toBeUndefined();
  });

  describe('enableHostAccess option', () => {
    it('should configure extra_hosts when enableHostAccess is true', () => {
      const config = { ...mockConfig, enableHostAccess: true };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const agent = result.services.agent;
      const squid = result.services['squid-proxy'];

      expect(agent.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
      expect(squid.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
    });

    it('should NOT configure extra_hosts when enableHostAccess is false', () => {
      const config = { ...mockConfig, enableHostAccess: false };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const agent = result.services.agent;
      const squid = result.services['squid-proxy'];

      expect(agent.extra_hosts).toBeUndefined();
      expect(squid.extra_hosts).toBeUndefined();
    });

    it('should NOT configure extra_hosts when enableHostAccess is undefined', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const squid = result.services['squid-proxy'];

      expect(agent.extra_hosts).toBeUndefined();
      expect(squid.extra_hosts).toBeUndefined();
    });

    it('should set AWF_ENABLE_HOST_ACCESS when enableHostAccess is true', () => {
      const config = { ...mockConfig, enableHostAccess: true };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.AWF_ENABLE_HOST_ACCESS).toBe('1');
    });

    it('should NOT set AWF_ENABLE_HOST_ACCESS when enableHostAccess is false', () => {
      const config = { ...mockConfig, enableHostAccess: false };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.AWF_ENABLE_HOST_ACCESS).toBeUndefined();
    });

    it('should NOT set AWF_ENABLE_HOST_ACCESS when enableHostAccess is undefined', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.AWF_ENABLE_HOST_ACCESS).toBeUndefined();
    });

    it('should set AWF_ENABLE_HOST_ACCESS to 1 via safety net when allowHostServicePorts is set without enableHostAccess', () => {
      const config = { ...mockConfig, allowHostServicePorts: '5432,6379' };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      expect(env.AWF_ENABLE_HOST_ACCESS).toBe('1');
      expect(env.AWF_HOST_SERVICE_PORTS).toBe('5432,6379');
    });
  });

  describe('NO_PROXY baseline', () => {
    it('should always set NO_PROXY with localhost entries', () => {
      // Default config without enableHostAccess or enableApiProxy
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;
      expect(env.NO_PROXY).toContain('localhost');
      expect(env.NO_PROXY).toContain('127.0.0.1');
      expect(env.NO_PROXY).toContain('::1');
      expect(env.NO_PROXY).toContain('0.0.0.0');
      expect(env.no_proxy).toBe(env.NO_PROXY);
    });

    it('should include agent IP in NO_PROXY', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;
      expect(env.NO_PROXY).toContain('172.30.0.20');
    });

    it('should append host.docker.internal to NO_PROXY when host access enabled', () => {
      const configWithHost = { ...mockConfig, enableHostAccess: true };
      const result = generateDockerCompose(configWithHost, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;
      // Should have both baseline AND host access entries
      expect(env.NO_PROXY).toContain('localhost');
      expect(env.NO_PROXY).toContain('host.docker.internal');
    });

    it('should sync no_proxy when --env overrides NO_PROXY', () => {
      const configWithEnv = {
        ...mockConfig,
        additionalEnv: { NO_PROXY: 'custom.local,127.0.0.1' },
      };
      const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.NO_PROXY).toBe('custom.local,127.0.0.1');
      expect(env.no_proxy).toBe(env.NO_PROXY);
    });

    it('should sync NO_PROXY when --env overrides no_proxy', () => {
      const configWithEnv = {
        ...mockConfig,
        additionalEnv: { no_proxy: 'custom.local,127.0.0.1' },
      };
      const result = generateDockerCompose(configWithEnv, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.no_proxy).toBe('custom.local,127.0.0.1');
      expect(env.NO_PROXY).toBe(env.no_proxy);
    });
  });

  it('should override environment variables with additionalEnv', () => {
    const originalEnv = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'original_token';

    try {
      const configWithOverride = {
        ...mockConfig,
        additionalEnv: {
          GITHUB_TOKEN: 'overridden_token',
        },
      };
      const result = generateDockerCompose(configWithOverride, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;

      // additionalEnv should win
      expect(env.GITHUB_TOKEN).toBe('overridden_token');
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  describe('dnsServers option', () => {
    it('should use custom DNS servers for Docker embedded DNS forwarding', () => {
      const config: WrapperConfig = {
        ...mockConfig,
        dnsServers: ['1.1.1.1', '1.0.0.1'],
      };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(agent.dns).toEqual(['1.1.1.1', '1.0.0.1']);
      // AWF_DNS_SERVERS env var should be set for setup-iptables.sh DNS ACCEPT rules
      expect(env.AWF_DNS_SERVERS).toBe('1.1.1.1,1.0.0.1');
    });

    it('should use default DNS servers when not specified', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(agent.dns).toEqual(['8.8.8.8', '8.8.4.4']);
      // AWF_DNS_SERVERS env var should be set for setup-iptables.sh DNS ACCEPT rules
      expect(env.AWF_DNS_SERVERS).toBe('8.8.8.8,8.8.4.4');
    });
  });
});
