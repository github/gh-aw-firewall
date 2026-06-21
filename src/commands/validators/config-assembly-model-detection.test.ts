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

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('COPILOT_MODEL detection in env files', () => {
    it('should detect COPILOT_MODEL in env file', () => {
      const envFilePath = path.join(getTestDir(), 'test.env');
      fs.writeFileSync(envFilePath, 'COPILOT_MODEL=gpt-4\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true,
        expect.any(Function),
      );
    });

    it('should detect COPILOT_MODEL with export prefix in env file', () => {
      const envFilePath = path.join(getTestDir(), 'test.env');
      fs.writeFileSync(envFilePath, 'export COPILOT_MODEL=gpt-4\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true,
        expect.any(Function),
      );
    });

    it('should skip comment lines when checking env file', () => {
      const envFilePath = path.join(getTestDir(), 'test.env');
      fs.writeFileSync(envFilePath, '# COPILOT_MODEL=gpt-4\nOTHER_VAR=value\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        false,
        expect.any(Function),
      );
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
      mockBuildConfigOnce({
        copilotGithubToken: 'ghp_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'gpt-4' };

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true,
        expect.any(Function),
      );
    });

    it('should detect COPILOT_MODEL from host env when --env-all is active', () => {
      const originalCopilotModel = process.env.COPILOT_MODEL;
      try {
        process.env.COPILOT_MODEL = 'gpt-4';

        mockBuildConfigOnce({
          envAll: true,
          copilotGithubToken: 'ghp_testtoken',
        });

        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          createMinimalAgentOptions(),
        );

        expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
          true,
          true,
          expect.any(Function),
        );
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

        mockBuildConfigOnce({
          envAll: true,
          copilotGithubToken: 'ghp_testtoken',
        });

        const agentOptions = createMinimalAgentOptions();
        agentOptions.additionalEnv = { COPILOT_MODEL: '' };

        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );

        expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
          true,
          false,
          expect.any(Function),
        );
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

      mockBuildConfigOnce({
        envFile: [envFilePath1, envFilePath2],
        copilotGithubToken: 'ghp_testtoken',
      });

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true,
        expect.any(Function),
      );
    });

    it('should reject retired COPILOT_MODEL aliases before launch', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
      });

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

    it('should reject retired COPILOT_MODEL aliases in BYOK mode (copilotProviderApiKey)', () => {
      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
      });

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

    it('should allow custom COPILOT_MODEL values in BYOK mode with a provider base URL', () => {
      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
        copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/o4-mini-aw',
        additionalEnv: { COPILOT_MODEL: 'o4-mini-aw' },
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
    });

    it('should allow custom COPILOT_MODEL values when provider base URL is set via env file', () => {
      const envFilePath = path.join(getTestDir(), 'byok.env');
      fs.writeFileSync(envFilePath, 'COPILOT_PROVIDER_BASE_URL=https://example-resource.openai.azure.com/openai/deployments/o4-mini-aw\n');

      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
        envFile: envFilePath,
        additionalEnv: { COPILOT_MODEL: 'o4-mini-aw' },
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
  });
});
