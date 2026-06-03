import { buildExclusionSet } from './excluded-vars';
import { PROXY_ENV_VARS } from '../../upstream-proxy';
import { WrapperConfig } from '../../types';

// Minimal WrapperConfig for tests
function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: [],
    ...overrides,
  } as WrapperConfig;
}

describe('buildExclusionSet', () => {
  describe('base exclusions (always excluded)', () => {
    it('should always exclude PATH', () => {
      const set = buildExclusionSet(makeConfig());
      expect(set.has('PATH')).toBe(true);
    });

    it('should always exclude shell state variables', () => {
      const set = buildExclusionSet(makeConfig());
      expect(set.has('PWD')).toBe(true);
      expect(set.has('OLDPWD')).toBe(true);
      expect(set.has('SHLVL')).toBe(true);
      expect(set.has('_')).toBe(true);
    });

    it('should always exclude sudo variables', () => {
      const set = buildExclusionSet(makeConfig());
      expect(set.has('SUDO_COMMAND')).toBe(true);
      expect(set.has('SUDO_USER')).toBe(true);
      expect(set.has('SUDO_UID')).toBe(true);
      expect(set.has('SUDO_GID')).toBe(true);
    });

    it('should always exclude GitHub Actions token variables', () => {
      const set = buildExclusionSet(makeConfig());
      expect(set.has('ACTIONS_RUNTIME_TOKEN')).toBe(true);
      expect(set.has('ACTIONS_RESULTS_URL')).toBe(true);
    });

    it('should always exclude AWF internal variables', () => {
      const set = buildExclusionSet(makeConfig());
      expect(set.has('AWF_PREFLIGHT_BINARY')).toBe(true);
      expect(set.has('AWF_STAGED_RUNNER_BINARY_NAME')).toBe(true);
      expect(set.has('AWF_GEMINI_ENABLED')).toBe(true);
      expect(set.has('MCP_GATEWAY_HOST_DOMAIN')).toBe(true);
    });

    it('should always exclude all proxy env vars', () => {
      const set = buildExclusionSet(makeConfig());
      for (const v of PROXY_ENV_VARS) {
        expect(set.has(v)).toBe(true);
      }
    });
  });

  describe('when enableApiProxy is true (security-critical)', () => {
    const config = makeConfig({ enableApiProxy: true });

    it('should exclude OPENAI_API_KEY', () => {
      expect(buildExclusionSet(config).has('OPENAI_API_KEY')).toBe(true);
    });

    it('should exclude OPENAI_KEY', () => {
      expect(buildExclusionSet(config).has('OPENAI_KEY')).toBe(true);
    });

    it('should exclude CODEX_API_KEY', () => {
      expect(buildExclusionSet(config).has('CODEX_API_KEY')).toBe(true);
    });

    it('should exclude ANTHROPIC_API_KEY', () => {
      expect(buildExclusionSet(config).has('ANTHROPIC_API_KEY')).toBe(true);
    });

    it('should exclude CLAUDE_API_KEY', () => {
      expect(buildExclusionSet(config).has('CLAUDE_API_KEY')).toBe(true);
    });

    it('should exclude COPILOT_GITHUB_TOKEN', () => {
      expect(buildExclusionSet(config).has('COPILOT_GITHUB_TOKEN')).toBe(true);
    });

    it('should exclude COPILOT_PROVIDER_API_KEY', () => {
      expect(buildExclusionSet(config).has('COPILOT_PROVIDER_API_KEY')).toBe(true);
    });

    it('should exclude GEMINI_API_KEY', () => {
      expect(buildExclusionSet(config).has('GEMINI_API_KEY')).toBe(true);
    });

    it('should exclude GOOGLE_GEMINI_BASE_URL', () => {
      expect(buildExclusionSet(config).has('GOOGLE_GEMINI_BASE_URL')).toBe(true);
    });

    it('should exclude GEMINI_API_BASE_URL', () => {
      expect(buildExclusionSet(config).has('GEMINI_API_BASE_URL')).toBe(true);
    });
  });

  describe('when enableApiProxy is false', () => {
    const config = makeConfig({ enableApiProxy: false });

    it('should NOT exclude OPENAI_API_KEY', () => {
      expect(buildExclusionSet(config).has('OPENAI_API_KEY')).toBe(false);
    });

    it('should NOT exclude ANTHROPIC_API_KEY', () => {
      expect(buildExclusionSet(config).has('ANTHROPIC_API_KEY')).toBe(false);
    });

    it('should NOT exclude COPILOT_GITHUB_TOKEN', () => {
      expect(buildExclusionSet(config).has('COPILOT_GITHUB_TOKEN')).toBe(false);
    });

    it('should NOT exclude GEMINI_API_KEY', () => {
      expect(buildExclusionSet(config).has('GEMINI_API_KEY')).toBe(false);
    });
  });

  describe('when difcProxyHost is set (DIFC proxy security)', () => {
    const config = makeConfig({ difcProxyHost: 'host.docker.internal:18443' });

    it('should exclude GITHUB_TOKEN', () => {
      expect(buildExclusionSet(config).has('GITHUB_TOKEN')).toBe(true);
    });

    it('should exclude GH_TOKEN', () => {
      expect(buildExclusionSet(config).has('GH_TOKEN')).toBe(true);
    });
  });

  describe('when difcProxyHost is not set', () => {
    const config = makeConfig({ difcProxyHost: undefined });

    it('should NOT exclude GITHUB_TOKEN', () => {
      expect(buildExclusionSet(config).has('GITHUB_TOKEN')).toBe(false);
    });

    it('should NOT exclude GH_TOKEN', () => {
      expect(buildExclusionSet(config).has('GH_TOKEN')).toBe(false);
    });
  });

  describe('when excludeEnv is set', () => {
    it('should exclude all custom env vars', () => {
      const config = makeConfig({ excludeEnv: ['MY_SECRET', 'ANOTHER_VAR'] });
      const set = buildExclusionSet(config);
      expect(set.has('MY_SECRET')).toBe(true);
      expect(set.has('ANOTHER_VAR')).toBe(true);
    });

    it('should handle empty excludeEnv array', () => {
      const config = makeConfig({ excludeEnv: [] });
      const set = buildExclusionSet(config);
      // Base exclusions still present
      expect(set.has('PATH')).toBe(true);
    });

    it('should handle undefined excludeEnv', () => {
      const config = makeConfig({ excludeEnv: undefined });
      const set = buildExclusionSet(config);
      // Base exclusions still present
      expect(set.has('PATH')).toBe(true);
    });
  });

  describe('combined configurations', () => {
    it('should combine apiProxy and difc exclusions', () => {
      const config = makeConfig({
        enableApiProxy: true,
        difcProxyHost: 'host.docker.internal:18443',
        excludeEnv: ['CUSTOM_SECRET'],
      });
      const set = buildExclusionSet(config);
      expect(set.has('ANTHROPIC_API_KEY')).toBe(true);
      expect(set.has('GITHUB_TOKEN')).toBe(true);
      expect(set.has('CUSTOM_SECRET')).toBe(true);
      expect(set.has('PATH')).toBe(true);
    });
  });
});
