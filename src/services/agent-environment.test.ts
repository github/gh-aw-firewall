import { generateDockerCompose } from '../docker-manager';
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

describe('agent service', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

    it('should configure agent container with proxy settings', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
      expect(env.https_proxy).toBe('http://172.30.0.10:3128');
      expect(env.SQUID_PROXY_HOST).toBe('squid-proxy');
      expect(env.SQUID_PROXY_PORT).toBe('3128');
    });

    it('should set lowercase https_proxy for Yarn 4 and Corepack compatibility', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      // Yarn 4 (undici), Corepack, and some Node.js HTTP clients only check lowercase
      expect(env.https_proxy).toBe(env.HTTPS_PROXY);
      // http_proxy is intentionally NOT set - see comment in docker-manager.ts
      expect(env.http_proxy).toBeUndefined();
    });

    it('should set NODE_EXTRA_CA_CERTS when SSL Bump is enabled', () => {
      const sslBumpConfig = { ...mockConfig, sslBump: true };
      const ssl = {
        caFiles: {
          certPath: `${mockConfig.workDir}/ssl/ca-cert.pem`,
          keyPath: `${mockConfig.workDir}/ssl/ca-key.pem`,
          derPath: `${mockConfig.workDir}/ssl/ca-cert.der`,
        },
        sslDbPath: `${mockConfig.workDir}/ssl_db`,
      };
      const result = generateDockerCompose(sslBumpConfig, mockNetworkConfig, ssl);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NODE_EXTRA_CA_CERTS).toBe('/usr/local/share/ca-certificates/awf-ca.crt');
      expect(env.AWF_SSL_BUMP_ENABLED).toBe('true');
    });

    it('should not set NODE_EXTRA_CA_CERTS when SSL Bump is disabled', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
      expect(env.AWF_SSL_BUMP_ENABLED).toBeUndefined();
    });

    it('should set NO_COLOR=1 when tty is false (default)', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.NO_COLOR).toBe('1');
      expect(env.FORCE_COLOR).toBeUndefined();
      expect(env.COLUMNS).toBeUndefined();
    });

    it('should set FORCE_COLOR, TERM, and COLUMNS when tty is true', () => {
      const ttyConfig = { ...mockConfig, tty: true };
      const result = generateDockerCompose(ttyConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const env = agent.environment as Record<string, string>;

      expect(env.FORCE_COLOR).toBe('1');
      expect(env.TERM).toBe('xterm-256color');
      expect(env.COLUMNS).toBe('120');
      expect(env.NO_COLOR).toBeUndefined();
    });

    it('should forward COPILOT_GITHUB_TOKEN when api-proxy is disabled', () => {
      process.env.COPILOT_GITHUB_TOKEN = 'ghp_test_token';
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_GITHUB_TOKEN).toBe('ghp_test_token');
      delete process.env.COPILOT_GITHUB_TOKEN;
    });

    it('should forward COPILOT_API_KEY when api-proxy is disabled', () => {
      process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
      const configNoProxy = { ...mockConfig, enableApiProxy: false };
      const result = generateDockerCompose(configNoProxy, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_API_KEY).toBe('cpat_test_byok_key');
      delete process.env.COPILOT_API_KEY;
    });

    it('should not forward COPILOT_API_KEY to agent when api-proxy is enabled', () => {
      process.env.COPILOT_API_KEY = 'cpat_test_byok_key';
      const configWithProxy = { ...mockConfig, enableApiProxy: true, copilotApiKey: 'cpat_test_byok_key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      // Placeholder is set to prevent --env-all from leaking the real key
      expect(env.COPILOT_API_KEY).toBe('placeholder-token-for-credential-isolation');
      delete process.env.COPILOT_API_KEY;
    });

    it('should not forward COPILOT_PROVIDER_API_KEY to agent from --env-all when api-proxy is enabled', () => {
      const providerApiKey = 'sk-real-provider-key';
      process.env.COPILOT_PROVIDER_API_KEY = providerApiKey;
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
      delete process.env.COPILOT_PROVIDER_API_KEY;
    });

    it('should keep COPILOT_PROVIDER_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
      const providerApiKey = 'sk-real-provider-key';
      const copilotApiKey = 'cpat-config-byok-key';
      process.env.COPILOT_PROVIDER_API_KEY = providerApiKey;
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_PROVIDER_API_KEY).toBe('placeholder-token-for-credential-isolation');
      delete process.env.COPILOT_PROVIDER_API_KEY;
    });

    it('should keep COPILOT_API_KEY placeholder when api-proxy is enabled with copilotApiKey and --env-all', () => {
      process.env.COPILOT_API_KEY = 'cpat-host-value';
      const configWithProxy = { ...mockConfig, enableApiProxy: true, envAll: true, copilotApiKey: 'cpat-config-byok-key' };
      const proxyNetworkConfig = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
      const result = generateDockerCompose(configWithProxy, proxyNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.COPILOT_API_KEY).toBe('placeholder-token-for-credential-isolation');
      delete process.env.COPILOT_API_KEY;
    });

    it('should forward AWF_ONE_SHOT_TOKEN_DEBUG when set', () => {
      process.env.AWF_ONE_SHOT_TOKEN_DEBUG = '1';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const env = result.services.agent.environment as Record<string, string>;
      expect(env.AWF_ONE_SHOT_TOKEN_DEBUG).toBe('1');
      delete process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
    });

    it('should set AWF_CHROOT_ENABLED environment variable', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_CHROOT_ENABLED).toBe('true');
    });

    it('should set AWF_REQUIRE_NODE when running Copilot CLI command', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'copilot --version' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBe('1');
    });

    it.each([
      { copilotGithubToken: 'ghu_test_token' },
      { copilotApiKey: 'cpat_test_key' },
    ])('should set AWF_REQUIRE_NODE when Copilot auth config is present: %o', (copilotConfig) => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test', ...copilotConfig },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBe('1');
    });

    it('should not set AWF_REQUIRE_NODE for non-Copilot commands', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_REQUIRE_NODE).toBeUndefined();
    });

    it('should set AWF_PREFLIGHT_BINARY=codex when running codex command', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'codex --version' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_PREFLIGHT_BINARY).toBe('codex');
    });

    it('should not set AWF_PREFLIGHT_BINARY for non-codex commands', () => {
      const result = generateDockerCompose(
        { ...mockConfig, agentCommand: 'echo test' },
        mockNetworkConfig,
      );
      const environment = result.services.agent.environment as Record<string, string>;

      expect(environment.AWF_PREFLIGHT_BINARY).toBeUndefined();
    });

    it('should pass GOROOT, CARGO_HOME, RUSTUP_HOME, JAVA_HOME, DOTNET_ROOT, BUN_INSTALL to container when env vars are set', () => {
      const originalGoroot = process.env.GOROOT;
      const originalCargoHome = process.env.CARGO_HOME;
      const originalRustupHome = process.env.RUSTUP_HOME;
      const originalJavaHome = process.env.JAVA_HOME;
      const originalDotnetRoot = process.env.DOTNET_ROOT;
      const originalBunInstall = process.env.BUN_INSTALL;

      process.env.GOROOT = '/usr/local/go';
      process.env.CARGO_HOME = '/home/user/.cargo';
      process.env.RUSTUP_HOME = '/home/user/.rustup';
      process.env.JAVA_HOME = '/usr/lib/jvm/java-17';
      process.env.DOTNET_ROOT = '/usr/lib/dotnet';
      process.env.BUN_INSTALL = '/home/user/.bun';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const environment = agent.environment as Record<string, string>;

        expect(environment.AWF_GOROOT).toBe('/usr/local/go');
        expect(environment.AWF_CARGO_HOME).toBe('/home/user/.cargo');
        expect(environment.AWF_RUSTUP_HOME).toBe('/home/user/.rustup');
        expect(environment.AWF_JAVA_HOME).toBe('/usr/lib/jvm/java-17');
        expect(environment.AWF_DOTNET_ROOT).toBe('/usr/lib/dotnet');
        expect(environment.AWF_BUN_INSTALL).toBe('/home/user/.bun');
      } finally {
        // Restore original values
        if (originalGoroot !== undefined) {
          process.env.GOROOT = originalGoroot;
        } else {
          delete process.env.GOROOT;
        }
        if (originalCargoHome !== undefined) {
          process.env.CARGO_HOME = originalCargoHome;
        } else {
          delete process.env.CARGO_HOME;
        }
        if (originalRustupHome !== undefined) {
          process.env.RUSTUP_HOME = originalRustupHome;
        } else {
          delete process.env.RUSTUP_HOME;
        }
        if (originalJavaHome !== undefined) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        if (originalDotnetRoot !== undefined) {
          process.env.DOTNET_ROOT = originalDotnetRoot;
        } else {
          delete process.env.DOTNET_ROOT;
        }
        if (originalBunInstall !== undefined) {
          process.env.BUN_INSTALL = originalBunInstall;
        } else {
          delete process.env.BUN_INSTALL;
        }
      }
    });

    it('should NOT set AWF_BUN_INSTALL when BUN_INSTALL is not in environment', () => {
      const originalBunInstall = process.env.BUN_INSTALL;
      delete process.env.BUN_INSTALL;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const agent = result.services.agent;
        const environment = agent.environment as Record<string, string>;

        expect(environment.AWF_BUN_INSTALL).toBeUndefined();
      } finally {
        if (originalBunInstall !== undefined) {
          process.env.BUN_INSTALL = originalBunInstall;
        }
      }
    });

    it('should set AWF_WORKDIR environment variable', () => {
      const configWithWorkDir = {
        ...mockConfig,
        containerWorkDir: '/workspace/project'
      };
      const result = generateDockerCompose(configWithWorkDir, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_WORKDIR).toBe('/workspace/project');
    });

    it('should pass through GITHUB_TOKEN when present in environment', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GITHUB_TOKEN).toBe('ghp_testtoken123');
      } finally {
        if (originalEnv !== undefined) {
          process.env.GITHUB_TOKEN = originalEnv;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    it('should not pass through GITHUB_TOKEN when not in environment', () => {
      const originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.GITHUB_TOKEN).toBeUndefined();
      } finally {
        if (originalEnv !== undefined) {
          process.env.GITHUB_TOKEN = originalEnv;
        }
      }
    });

    it('should pass through ACTIONS_ID_TOKEN_REQUEST_URL when present in environment', () => {
      const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.actions.githubusercontent.com/abc';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://token.actions.githubusercontent.com/abc');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = originalEnv;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        }
      }
    });

    it('should pass through ACTIONS_ID_TOKEN_REQUEST_TOKEN when present in environment', () => {
      const originalEnv = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'test-oidc-token-value';

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe('test-oidc-token-value');
      } finally {
        if (originalEnv !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = originalEnv;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        }
      }
    });

    it('should not pass through OIDC variables when not in environment', () => {
      const origUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const origToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

      try {
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
        expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      } finally {
        if (origUrl !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_URL = origUrl;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        }
        if (origToken !== undefined) {
          process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = origToken;
        } else {
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
        }
      }
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

    it('should never pass ACTIONS_RUNTIME_TOKEN to agent container', () => {
      const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
      process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

      try {
        // Should not be passed in default mode
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      } finally {
        if (originalToken !== undefined) {
          process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
        } else {
          delete process.env.ACTIONS_RUNTIME_TOKEN;
        }
      }
    });

    it('should never pass ACTIONS_RESULTS_URL to agent container', () => {
      const originalUrl = process.env.ACTIONS_RESULTS_URL;
      process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

      try {
        // Should not be passed in default mode
        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
      } finally {
        if (originalUrl !== undefined) {
          process.env.ACTIONS_RESULTS_URL = originalUrl;
        } else {
          delete process.env.ACTIONS_RESULTS_URL;
        }
      }
    });

    it('should exclude ACTIONS_RUNTIME_TOKEN from env-all passthrough', () => {
      const originalToken = process.env.ACTIONS_RUNTIME_TOKEN;
      process.env.ACTIONS_RUNTIME_TOKEN = 'test-runtime-token-value';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
      } finally {
        if (originalToken !== undefined) {
          process.env.ACTIONS_RUNTIME_TOKEN = originalToken;
        } else {
          delete process.env.ACTIONS_RUNTIME_TOKEN;
        }
      }
    });

    it('should exclude ACTIONS_RESULTS_URL from env-all passthrough', () => {
      const originalUrl = process.env.ACTIONS_RESULTS_URL;
      process.env.ACTIONS_RESULTS_URL = 'https://results-receiver.actions.githubusercontent.com/';

      try {
        const configWithEnvAll = { ...mockConfig, envAll: true };
        const result = generateDockerCompose(configWithEnvAll, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;
        expect(env.ACTIONS_RESULTS_URL).toBeUndefined();
      } finally {
        if (originalUrl !== undefined) {
          process.env.ACTIONS_RESULTS_URL = originalUrl;
        } else {
          delete process.env.ACTIONS_RESULTS_URL;
        }
      }
    });

    it('should exclude system variables when envAll is enabled', () => {
      const originalPath = process.env.PATH;
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
        delete process.env.CUSTOM_HOST_VAR;
      }
    });

    it('should exclude specified variables when excludeEnv is set with envAll', () => {
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
        delete process.env.CUSTOM_HOST_VAR;
        delete process.env.SECRET_TOKEN;
      }
    });

    it('should exclude multiple variables when excludeEnv contains multiple names', () => {
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
        delete process.env.TOKEN_A;
        delete process.env.TOKEN_B;
        delete process.env.SAFE_VAR;
      }
    });

    it('should have no effect when excludeEnv is set but envAll is false', () => {
      process.env.SECRET_TOKEN = 'super-secret';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: false, excludeEnv: ['SECRET_TOKEN'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // envAll is false so SECRET_TOKEN was never going to be injected anyway
        expect(env.SECRET_TOKEN).toBeUndefined();
      } finally {
        delete process.env.SECRET_TOKEN;
      }
    });

    it('should exclude GITHUB_TOKEN from env-all passthrough when specified in excludeEnv', () => {
      const prevToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_test_token';

      try {
        const configWithExcludeEnv = { ...mockConfig, envAll: true, excludeEnv: ['GITHUB_TOKEN'] };
        const result = generateDockerCompose(configWithExcludeEnv, mockNetworkConfig);
        const env = result.services.agent.environment as Record<string, string>;

        // GITHUB_TOKEN should be excluded from the env-all passthrough
        expect(env.GITHUB_TOKEN).toBeUndefined();
      } finally {
        if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
        else delete process.env.GITHUB_TOKEN;
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
