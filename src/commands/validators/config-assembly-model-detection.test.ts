import * as fs from 'fs';
import * as path from 'path';
import {
  assembleAndValidateConfig,
  createMinimalAgentOptions,
  createMinimalLogAndLimits,
  createMinimalNetworkOptions,
  getTestDir,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
  warnClassicPATWithCopilotModel,
} from './config-assembly.test-utils';
import { testHelpers } from './api-proxy-validator';

const { resolveAliasToFirstConcrete } = testHelpers;

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('COPILOT_MODEL detection in env files', () => {
    /**
     * Runs a COPILOT_MODEL detection case and asserts warnClassicPATWithCopilotModel.
     * Optionally writes a single env file from `envFileContents` and passes extra
     * buildConfig/agentEnv overrides.
     */
    function runCopilotModelDetectionCase({
      envFileContents,
      buildConfigOverrides = {},
      agentEnv,
      expectedModelDetected,
    }: {
      envFileContents?: string;
      buildConfigOverrides?: Record<string, unknown>;
      agentEnv?: Record<string, string>;
      expectedModelDetected: boolean;
    }): void {
      let envFilePath: string | undefined;
      if (envFileContents !== undefined) {
        envFilePath = path.join(getTestDir(), 'test.env');
        fs.writeFileSync(envFilePath, envFileContents);
      }

      mockBuildConfigOnce({
        copilotGithubToken: 'ghp_testtoken',
        ...(envFilePath !== undefined ? { envFile: envFilePath } : {}),
        ...buildConfigOverrides,
      });

      const agentOptions = createMinimalAgentOptions();
      if (agentEnv !== undefined) {
        agentOptions.additionalEnv = agentEnv;
      }

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        expectedModelDetected,
        expect.any(Function),
      );
    }

    it.each<[string, string, boolean]>([
      ['should detect COPILOT_MODEL in env file', 'COPILOT_MODEL=gpt-4\n', true],
      ['should detect COPILOT_MODEL with export prefix in env file', 'export COPILOT_MODEL=gpt-4\n', true],
      ['should skip comment lines when checking env file', '# COPILOT_MODEL=gpt-4\nOTHER_VAR=value\n', false],
    ])('%s', (_description, envFileContents, expectedModelDetected) => {
      runCopilotModelDetectionCase({ envFileContents, expectedModelDetected });
    });

    it('should handle unreadable env file gracefully', () => {
      mockBuildConfigOnce({
        envFile: '/nonexistent/file.env',
        copilotGithubToken: 'ghp_testtoken',
      });

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          createMinimalAgentOptions(),
        );
      }).not.toThrow();
    });

    it('should detect COPILOT_MODEL from --env flags', () => {
      runCopilotModelDetectionCase({ agentEnv: { COPILOT_MODEL: 'gpt-4' }, expectedModelDetected: true });
    });

    it('should detect COPILOT_MODEL from host env when --env-all is active', () => {
      const originalCopilotModel = process.env.COPILOT_MODEL;
      try {
        process.env.COPILOT_MODEL = 'gpt-4';
        runCopilotModelDetectionCase({ buildConfigOverrides: { envAll: true }, expectedModelDetected: true });
      } finally {
        if (originalCopilotModel) {
          process.env.COPILOT_MODEL = originalCopilotModel;
        } else {
          delete process.env.COPILOT_MODEL;
        }
      }
    });

    it('should not fall back to host env when --env sets empty COPILOT_MODEL', () => {
      const originalCopilotModel = process.env.COPILOT_MODEL;
      try {
        process.env.COPILOT_MODEL = 'gpt-4';
        runCopilotModelDetectionCase({
          buildConfigOverrides: { envAll: true },
          agentEnv: { COPILOT_MODEL: '' },
          expectedModelDetected: false,
        });
      } finally {
        if (originalCopilotModel) {
          process.env.COPILOT_MODEL = originalCopilotModel;
        } else {
          delete process.env.COPILOT_MODEL;
        }
      }
    });

    it('should handle array of env files', () => {
      const envFilePath1 = path.join(getTestDir(), 'test1.env');
      const envFilePath2 = path.join(getTestDir(), 'test2.env');
      fs.writeFileSync(envFilePath1, 'VAR1=value1\n');
      fs.writeFileSync(envFilePath2, 'COPILOT_MODEL=gpt-4\n');

      runCopilotModelDetectionCase({
        buildConfigOverrides: { envFile: [envFilePath1, envFilePath2] },
        expectedModelDetected: true,
      });
    });

    it.each<[string, string, string]>([
      ['should reject retired COPILOT_MODEL aliases before launch', 'copilotGithubToken', 'github_pat_testtoken'],
      ['should reject retired COPILOT_MODEL aliases in BYOK mode (copilotProviderApiKey)', 'copilotProviderApiKey', 'byok-api-key-for-azure-foundry'],
    ])('%s', (_description, tokenKey, tokenValue) => {
      mockBuildConfigOnce({ [tokenKey]: tokenValue });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'gpt-5-codex' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("model 'gpt-5-codex' is retired or unsupported"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Did you mean 'gpt-5.3-codex'?"),
      );
    });

    function expectByokModelAllowed(buildConfigOverrides: Record<string, unknown>): void {
      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
        additionalEnv: { COPILOT_MODEL: 'o4-mini-aw' },
        ...buildConfigOverrides,
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'o4-mini-aw' };

      const result = assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(logger.error).not.toHaveBeenCalled();
      expect(result.additionalEnv?.COPILOT_MODEL).toBe('o4-mini-aw');
    }

    it('should allow custom COPILOT_MODEL values in BYOK mode with a provider base URL', () => {
      expectByokModelAllowed({
        copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/o4-mini-aw',
      });
    });

    it('should allow custom COPILOT_MODEL values when provider base URL is set via env file', () => {
      const envFilePath = path.join(getTestDir(), 'byok.env');
      fs.writeFileSync(
        envFilePath,
        'COPILOT_PROVIDER_BASE_URL=https://example-resource.openai.azure.com/openai/deployments/o4-mini-aw\n',
      );
      expectByokModelAllowed({ envFile: envFilePath });
    });

    it('should log normalization when COPILOT_MODEL casing is adjusted', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: ' GPT-4.1 ' };

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(logger.info).toHaveBeenCalledWith(
        "Normalized COPILOT_MODEL value 'GPT-4.1' -> 'gpt-4.1'",
      );
    });

    it('should allow COPILOT_MODEL=auto', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'auto' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).not.toThrow();

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should allow COPILOT_MODEL that matches a runtime alias key and resolves to a valid concrete model', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: { small: ['gpt-4o-mini', 'gpt-4.1-mini'] },
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = { small: ['gpt-4o-mini', 'gpt-4.1-mini'] };

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'small' };

      const result = assembleAndValidateConfig(
        {},
        'echo test',
        logAndLimits,
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(logger.error).not.toHaveBeenCalled();
      // COPILOT_MODEL must remain as the alias name (not the resolved concrete model)
      // so the api-proxy can perform its own availability-aware resolution.
      expect(result.additionalEnv?.COPILOT_MODEL).toBeUndefined();
    });

    it('should allow COPILOT_MODEL alias regardless of case (Small -> matches alias key small)', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: { small: ['gpt-4o-mini'] },
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = { small: ['gpt-4o-mini'] };

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'Small' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).not.toThrow();

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should reject alias whose first concrete pattern resolves to an unsupported model', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: { bad: ['not-a-real-model-xyz'] },
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = { bad: ['not-a-real-model-xyz'] };

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'bad' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("alias 'bad' resolves to model 'not-a-real-model-xyz'"),
      );
    });

    it('should allow alias with only wildcard patterns (cannot validate at preflight)', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: { sonnet: ['copilot/*sonnet*'] },
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = { sonnet: ['copilot/*sonnet*'] };

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'sonnet' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).not.toThrow();

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should still reject unsupported COPILOT_MODEL values that are not runtime aliases', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: { small: ['gpt-4o-mini'] },
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = { small: ['gpt-4o-mini'] };

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'not-a-real-model-xyz' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("model 'not-a-real-model-xyz' is unsupported or unrecognized"),
      );
    });

    it('should resolve a recursive alias chain (smart -> fast -> gpt-4.1) and validate the concrete model', () => {
      const aliases = { fast: ['gpt-4.1'], smart: ['fast'] };
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: aliases,
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = aliases;

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'smart' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).not.toThrow();

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should reject a recursive alias chain that resolves to an unsupported model', () => {
      const aliases = { inner: ['not-a-real-model-xyz'], outer: ['inner'] };
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: aliases,
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = aliases;

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'outer' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("alias 'outer' resolves to model 'not-a-real-model-xyz'"),
      );
    });

    it('should allow a cyclic alias chain without crashing (cycle protection)', () => {
      const aliases = { alpha: ['beta'], beta: ['alpha'] };
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
        modelAliases: aliases,
      });

      const logAndLimits = createMinimalLogAndLimits();
      logAndLimits.modelAliases = aliases;

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'alpha' };

      // Cyclic alias resolves to undefined (no concrete model) — skips validation
      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          logAndLimits,
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).not.toThrow();

      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('resolveAliasToFirstConcrete', () => {
    it('returns undefined for unknown alias key', () => {
      expect(resolveAliasToFirstConcrete('unknown', { fast: ['gpt-4.1'] })).toBeUndefined();
    });

    it('returns the first concrete pattern for a direct alias', () => {
      expect(resolveAliasToFirstConcrete('fast', { fast: ['gpt-4.1', 'gpt-4o'] })).toBe('gpt-4.1');
    });

    it('skips wildcards and returns the first non-wildcard', () => {
      expect(resolveAliasToFirstConcrete('s', { s: ['copilot/*sonnet*', 'gpt-4.1'] })).toBe('gpt-4.1');
    });

    it('skips provider-scoped patterns', () => {
      expect(resolveAliasToFirstConcrete('s', { s: ['copilot/gpt-4.1', 'gpt-4o-mini'] })).toBe('gpt-4o-mini');
    });

    it('returns undefined when all patterns are wildcards', () => {
      expect(resolveAliasToFirstConcrete('s', { s: ['copilot/*sonnet*'] })).toBeUndefined();
    });

    it('resolves a one-level nested alias', () => {
      expect(resolveAliasToFirstConcrete('smart', { fast: ['gpt-4.1'], smart: ['fast'] })).toBe('gpt-4.1');
    });

    it('resolves a multi-level nested alias chain', () => {
      const aliases = { a: ['b'], b: ['c'], c: ['gpt-4o-mini'] };
      expect(resolveAliasToFirstConcrete('a', aliases)).toBe('gpt-4o-mini');
    });

    it('returns undefined for a direct cycle', () => {
      expect(resolveAliasToFirstConcrete('x', { x: ['x'] })).toBeUndefined();
    });

    it('returns undefined for a mutual cycle', () => {
      expect(resolveAliasToFirstConcrete('a', { a: ['b'], b: ['a'] })).toBeUndefined();
    });

    it('skips a cyclic branch and falls through to a valid sibling pattern', () => {
      const aliases = { a: ['b', 'gpt-4.1'], b: ['a'] };
      expect(resolveAliasToFirstConcrete('a', aliases)).toBe('gpt-4.1');
    });

    it('is case-insensitive for alias key lookup', () => {
      expect(resolveAliasToFirstConcrete('FAST', { fast: ['gpt-4.1'] })).toBe('gpt-4.1');
    });

    it('is case-insensitive when following nested alias references', () => {
      expect(resolveAliasToFirstConcrete('smart', { FAST: ['gpt-4.1'], smart: ['FAST'] })).toBe('gpt-4.1');
    });
  });
});
