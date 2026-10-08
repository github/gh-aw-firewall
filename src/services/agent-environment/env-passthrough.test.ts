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

  describe('--env-all drops host-only paths under unmounted RUNNER_TEMP subtrees', () => {
    const runnerTemp = '/home/runner/work/_temp';

    function runEnvAll(
      vars: Record<string, string>,
      overrides: Partial<WrapperConfig> = {},
      environment: Record<string, string> = {},
    ): Record<string, string> {
      withEnv({ RUNNER_TEMP: runnerTemp, GITHUB_WORKSPACE: '/home/runner/work/repo/repo', ...vars }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ envAll: true, ...overrides }),
          environment,
          excludedEnvVars: new Set<string>(),
        });
      });
      return environment;
    }

    it('drops setup-uv UV_CACHE_DIR and UV_PYTHON_INSTALL_DIR', () => {
      const environment = runEnvAll({
        UV_CACHE_DIR: `${runnerTemp}/setup-uv-cache`,
        UV_PYTHON_INSTALL_DIR: `${runnerTemp}/uv-python-dir`,
      });

      expect(environment).not.toHaveProperty('UV_CACHE_DIR');
      expect(environment).not.toHaveProperty('UV_PYTHON_INSTALL_DIR');
      expect(environment).toHaveProperty('RUNNER_TEMP', runnerTemp);
    });

    it('drops any absolute path under RUNNER_TEMP, including traversal out of a mounted subtree', () => {
      const environment = runEnvAll(
        {
          SOME_TOOL_DIR: `${runnerTemp}/other-tool/nested/`,
          DOT_PREFIXED_DIR: `${runnerTemp}/..cache`,
          TRAVERSAL_DIR: `${runnerTemp}/gh-aw/../setup-uv-cache`,
        },
        { volumeMounts: [`${runnerTemp}/gh-aw:${runnerTemp}/gh-aw:ro`] },
      );

      expect(environment).not.toHaveProperty('SOME_TOOL_DIR');
      expect(environment).not.toHaveProperty('DOT_PREFIXED_DIR');
      expect(environment).not.toHaveProperty('TRAVERSAL_DIR');
    });

    it('keeps paths covered by a custom mount', () => {
      const environment = runEnvAll(
        {
          GH_AW_SAFE_OUTPUTS: `${runnerTemp}/gh-aw/safeoutputs/outputs.jsonl`,
          GH_AW_DIR: `${runnerTemp}/gh-aw`,
        },
        { volumeMounts: [`${runnerTemp}/gh-aw:${runnerTemp}/gh-aw:ro`] },
      );

      expect(environment).toHaveProperty('GH_AW_SAFE_OUTPUTS', `${runnerTemp}/gh-aw/safeoutputs/outputs.jsonl`);
      expect(environment).toHaveProperty('GH_AW_DIR', `${runnerTemp}/gh-aw`);
    });

    it('keeps values equal to RUNNER_TEMP, relative values, and paths outside RUNNER_TEMP', () => {
      const environment = runEnvAll({
        TEMP_ROOT_ALIAS: runnerTemp,
        RELATIVE_DIR: '_temp/setup-uv-cache',
        SIBLING_DIR: `${runnerTemp}-other/cache`,
        TOOL_CACHE_DIR: '/opt/hostedtoolcache',
      });

      expect(environment).toHaveProperty('TEMP_ROOT_ALIAS', runnerTemp);
      expect(environment).toHaveProperty('RELATIVE_DIR', '_temp/setup-uv-cache');
      expect(environment).toHaveProperty('SIBLING_DIR', `${runnerTemp}-other/cache`);
      expect(environment).toHaveProperty('TOOL_CACHE_DIR', '/opt/hostedtoolcache');
    });

    it('keeps paths when RUNNER_TEMP lies inside an always-mounted root such as /tmp', () => {
      const environment: Record<string, string> = {};
      withEnv({ RUNNER_TEMP: '/tmp/runner-temp', UV_CACHE_DIR: '/tmp/runner-temp/setup-uv-cache' }, () => {
        passthroughHostEnvironment({
          config: makeConfig({ envAll: true }),
          environment,
          excludedEnvVars: new Set<string>(),
        });
      });

      expect(environment).toHaveProperty('UV_CACHE_DIR', '/tmp/runner-temp/setup-uv-cache');
    });

    it('does not remove values that were set before host passthrough', () => {
      const environment = runEnvAll(
        { UV_CACHE_DIR: `${runnerTemp}/setup-uv-cache` },
        {},
        { AWF_PRESET_DIR: `${runnerTemp}/preset` },
      );

      expect(environment).toHaveProperty('AWF_PRESET_DIR', `${runnerTemp}/preset`);
      expect(environment).not.toHaveProperty('UV_CACHE_DIR');
    });

    it('does not filter when RUNNER_TEMP is unset', () => {
      const environment: Record<string, string> = {};
      const originalRunnerTemp = process.env.RUNNER_TEMP;
      delete process.env.RUNNER_TEMP;
      try {
        withEnv({ UV_CACHE_DIR: '/home/runner/work/_temp/setup-uv-cache' }, () => {
          passthroughHostEnvironment({
            config: makeConfig({ envAll: true }),
            environment,
            excludedEnvVars: new Set<string>(),
          });
        });
      } finally {
        if (originalRunnerTemp !== undefined) {
          process.env.RUNNER_TEMP = originalRunnerTemp;
        }
      }

      expect(environment).toHaveProperty('UV_CACHE_DIR', '/home/runner/work/_temp/setup-uv-cache');
    });
  });
});
