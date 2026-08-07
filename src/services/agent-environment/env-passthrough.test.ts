import { passthroughHostEnvironment } from './env-passthrough';
import { WrapperConfig } from '../../types';

// Mock the logger to suppress output during tests
jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: [],
    ...overrides,
  } as WrapperConfig;
}

describe('passthroughHostEnvironment', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save and clear relevant env vars before each test
    savedEnv = {};
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  function withEnv(vars: Record<string, string>, fn: () => void): void {
    for (const [key, val] of Object.entries(vars)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
    fn();
  }

  describe('alwaysForwardVars respect the exclusion set (root-cause fix)', () => {
    it('does not forward GITHUB_TOKEN when it is in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set(['GITHUB_TOKEN']);

      withEnv({ GITHUB_TOKEN: 'ghs_secret' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    });

    it('does not forward GH_TOKEN when it is in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set(['GH_TOKEN']);

      withEnv({ GH_TOKEN: 'ghs_secret' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).not.toHaveProperty('GH_TOKEN');
    });

    it('does not forward GITHUB_PERSONAL_ACCESS_TOKEN when it is in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set(['GITHUB_PERSONAL_ACCESS_TOKEN']);

      withEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    });

    it('does not forward direct provider credentials when API proxy is disabled but they are excluded', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set(['COPILOT_GITHUB_TOKEN', 'OPENAI_API_KEY']);

      withEnv({
        COPILOT_GITHUB_TOKEN: 'copilot-secret',
        OPENAI_API_KEY: 'openai-secret',
      }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: false }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    });

    it('forwards GITHUB_TOKEN when it is NOT in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set<string>();

      withEnv({ GITHUB_TOKEN: 'ghs_allowed' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: false }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).toHaveProperty('GITHUB_TOKEN', 'ghs_allowed');
    });

    it('forwards GH_TOKEN when it is NOT in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set<string>();

      withEnv({ GH_TOKEN: 'ghs_allowed' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: false }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).toHaveProperty('GH_TOKEN', 'ghs_allowed');
    });

    it('suppresses all three GitHub token aliases together when all are excluded', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN']);

      withEnv(
        {
          GITHUB_TOKEN: 'ghs_tok',
          GH_TOKEN: 'ghs_tok2',
          GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_tok',
        },
        () => {
          passthroughHostEnvironment({
            config: makeConfig({ enableApiProxy: true }),
            environment,
            excludedEnvVars,
          });
        },
      );

      expect(environment).not.toHaveProperty('GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('GH_TOKEN');
      expect(environment).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    });

    it('forwards AZURE_CONFIG_DIR when it is NOT in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set<string>();

      withEnv({ AZURE_CONFIG_DIR: '/home/runner/.azure' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).toHaveProperty('AZURE_CONFIG_DIR', '/home/runner/.azure');
    });

    it('forwards ADO_MCP_AUTH_TOKEN when it is NOT in the exclusion set', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set<string>();

      withEnv({ ADO_MCP_AUTH_TOKEN: 'ado-auth-token' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      expect(environment).toHaveProperty('ADO_MCP_AUTH_TOKEN', 'ado-auth-token');
    });

    it('forwards OTEL trace context variables to agent but withholds collector credentials', () => {
      const environment: Record<string, string> = {};
      const excludedEnvVars = new Set<string>();

      withEnv({
        GH_AW_OTLP_ENDPOINTS: '[{"url":"https://otel.example.com","headers":"x-sentry-auth=secret"}]',
        GITHUB_AW_OTEL_TRACE_ID: 'trace-id-abc123',
        GITHUB_AW_OTEL_PARENT_SPAN_ID: 'span-id-xyz789',
      }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ enableApiProxy: true }),
          environment,
          excludedEnvVars,
        });
      });

      // Trace context propagates so nested AWF runs can link spans correctly
      expect(environment).toHaveProperty('GITHUB_AW_OTEL_TRACE_ID', 'trace-id-abc123');
      expect(environment).toHaveProperty('GITHUB_AW_OTEL_PARENT_SPAN_ID', 'span-id-xyz789');
      // GH_AW_OTLP_ENDPOINTS contains collector credentials ({url, headers}) and MUST NOT
      // reach the untrusted agent container — it is forwarded only to the api-proxy sidecar
      // via api-proxy-env-config (spec §9.2)
      expect(environment).not.toHaveProperty('GH_AW_OTLP_ENDPOINTS');
    });
  });
});
