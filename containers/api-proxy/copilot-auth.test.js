const {
  _testing: {
    resolveCopilotAuthToken,
    resolveApiKey,
    stripBearerPrefix,
    isGhesInstance,
    copilotTargetRequiresGitHubTokenPrefix,
  },
} = require('./providers/copilot-auth');
const {
  _testing: {
    buildCopilotAuthErrorMessage,
  },
} = require('./upstream-response');
const {
  _testing: {
    COPILOT_PLACEHOLDER_TOKEN,
  },
} = require('./providers/copilot-byok');

const bearerSkToken = ['Bearer', 'sk-or-v1-abc'].join(' ');
const bearerByokToken = ['Bearer', 'sk-byok-key'].join(' ');
const bearerGithubToken = ['Bearer', 'gho_abc123'].join(' ');

describe('stripBearerPrefix', () => {
  it('strips "Bearer " prefix from a token value', () => {
    expect(stripBearerPrefix(bearerSkToken)).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix case-insensitively', () => {
    expect(stripBearerPrefix('bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('BEARER sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips "token " prefix case-insensitively', () => {
    expect(stripBearerPrefix('token sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('TOKEN sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips leading whitespace before "Bearer "', () => {
    expect(stripBearerPrefix(`  ${bearerSkToken}`)).toBe('sk-or-v1-abc');
  });

  it('returns value unchanged when no "Bearer " prefix is present', () => {
    expect(stripBearerPrefix('sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('gho_abc123')).toBe('gho_abc123');
  });

  it('does not strip "Bearer" without a following space', () => {
    expect(stripBearerPrefix('BearerToken123')).toBe('BearerToken123');
  });

  it('returns undefined when value is only "Bearer " (nothing after prefix)', () => {
    expect(stripBearerPrefix('Bearer ')).toBeUndefined();
    expect(stripBearerPrefix('Bearer   ')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only input', () => {
    expect(stripBearerPrefix('')).toBeUndefined();
    expect(stripBearerPrefix('   ')).toBeUndefined();
    expect(stripBearerPrefix(undefined)).toBeUndefined();
  });

  it('trims surrounding whitespace from the token', () => {
    expect(stripBearerPrefix('  sk-or-v1-abc  ')).toBe('sk-or-v1-abc');
  });
});

describe('resolveCopilotAuthToken', () => {
  it('should return COPILOT_GITHUB_TOKEN when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'gho_abc123' })).toBe('gho_abc123');
  });

  it('should return COPILOT_PROVIDER_API_KEY when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('should prefer COPILOT_PROVIDER_API_KEY over COPILOT_GITHUB_TOKEN when both are set', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('should return undefined when neither is set', () => {
    expect(resolveCopilotAuthToken({})).toBeUndefined();
  });

  it('should return undefined for empty strings', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '', COPILOT_PROVIDER_API_KEY: '' })).toBeUndefined();
  });

  it('should return undefined for whitespace-only values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '  ', COPILOT_PROVIDER_API_KEY: '  \n' })).toBeUndefined();
  });

  it('should trim whitespace from token values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: '  sk-byok-key  ' })).toBe('sk-byok-key');
  });

  it('should use COPILOT_PROVIDER_API_KEY when COPILOT_GITHUB_TOKEN is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: '  ',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  it('should fall back to COPILOT_GITHUB_TOKEN when COPILOT_PROVIDER_API_KEY is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_PROVIDER_API_KEY: '  ',
    })).toBe('gho_abc123');
  });

  it('strips "Bearer " prefix from COPILOT_PROVIDER_API_KEY when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: bearerSkToken })).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix from COPILOT_GITHUB_TOKEN when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: bearerGithubToken })).toBe('gho_abc123');
  });

  it('prefers stripped COPILOT_PROVIDER_API_KEY over stripped COPILOT_GITHUB_TOKEN', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: bearerGithubToken,
      COPILOT_PROVIDER_API_KEY: bearerByokToken,
    })).toBe('sk-byok-key');
  });

  it('treats AWF placeholder COPILOT_PROVIDER_API_KEY as absent when no COPILOT_GITHUB_TOKEN is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN })).toBeUndefined();
  });

  it('uses COPILOT_GITHUB_TOKEN when COPILOT_PROVIDER_API_KEY is the AWF placeholder', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_real_token',
      COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN,
    })).toBe('gho_real_token');
  });
});

describe('resolveApiKey', () => {
  it('returns the API key when it is a real credential', () => {
    expect(resolveApiKey({ COPILOT_PROVIDER_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('returns undefined when COPILOT_PROVIDER_API_KEY is the AWF placeholder', () => {
    expect(resolveApiKey({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN })).toBeUndefined();
  });

  it('returns undefined when COPILOT_PROVIDER_API_KEY is not set', () => {
    expect(resolveApiKey({})).toBeUndefined();
  });
});

describe('buildCopilotAuthErrorMessage', () => {
  it('treats an empty stripped BYOK key as missing', () => {
    const message = buildCopilotAuthErrorMessage(401, {
      COPILOT_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      COPILOT_PROVIDER_API_KEY: 'Bearer   ',
    });

    expect(message).toContain('COPILOT_PROVIDER_API_KEY is not set');
  });
});

describe('isGhesInstance', () => {
  it('returns true for api.enterprise.githubcopilot.com target', () => {
    expect(isGhesInstance('api.enterprise.githubcopilot.com', {})).toBe(true);
  });

  it('returns true when GITHUB_SERVER_URL is a custom GHES hostname', () => {
    expect(isGhesInstance('custom-proxy.internal', { GITHUB_SERVER_URL: 'https://ghes.mycompany.com' })).toBe(true);
  });

  it('returns false when GITHUB_SERVER_URL is github.com', () => {
    expect(isGhesInstance('custom-proxy.internal', { GITHUB_SERVER_URL: 'https://github.com' })).toBe(false);
  });

  it('returns false when GITHUB_SERVER_URL is a *.ghe.com tenant', () => {
    expect(isGhesInstance('custom-proxy.internal', { GITHUB_SERVER_URL: 'https://myorg.ghe.com' })).toBe(false);
  });

  it('returns false when no GHES indicators are present', () => {
    expect(isGhesInstance('api.githubcopilot.com', {})).toBe(false);
  });

  it('returns false when GITHUB_SERVER_URL is unset', () => {
    expect(isGhesInstance('custom-proxy.internal', {})).toBe(false);
  });

  it('returns true when AWF_PLATFORM_TYPE is ghes (highest priority)', () => {
    expect(isGhesInstance('api.githubcopilot.com', { AWF_PLATFORM_TYPE: 'ghes' })).toBe(true);
  });

  it('returns true when AWF_PLATFORM_TYPE is ghes even without GITHUB_SERVER_URL', () => {
    expect(isGhesInstance('custom-proxy.internal', { AWF_PLATFORM_TYPE: 'ghes' })).toBe(true);
  });

  it('returns false when AWF_PLATFORM_TYPE is github.com even if GITHUB_SERVER_URL looks like GHES', () => {
    expect(isGhesInstance('custom-proxy.internal', {
      AWF_PLATFORM_TYPE: 'github.com',
      GITHUB_SERVER_URL: 'https://ghes.mycompany.com',
    })).toBe(false);
  });

  it('returns false when AWF_PLATFORM_TYPE is ghec', () => {
    expect(isGhesInstance('api.enterprise.githubcopilot.com', { AWF_PLATFORM_TYPE: 'ghec' })).toBe(false);
  });

  it('returns false when AWF_PLATFORM_TYPE is ghec-self-hosted', () => {
    expect(isGhesInstance('custom-proxy.internal', {
      AWF_PLATFORM_TYPE: 'ghec-self-hosted',
      GITHUB_SERVER_URL: 'https://ghes.mycompany.com',
    })).toBe(false);
  });
});

describe('copilotTargetRequiresGitHubTokenPrefix', () => {
  it('returns true for the Enterprise Copilot endpoint', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('api.enterprise.githubcopilot.com', {})).toBe(true);
  });

  it('returns true for the Business Copilot endpoint', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('api.business.githubcopilot.com', {})).toBe(true);
  });

  it('returns true for the Business endpoint even on a *.ghe.com (GHEC) server', () => {
    // Regression: Copilot Business customers set COPILOT_API_TARGET to the
    // business host while running against a *.ghe.com server. isGhesInstance
    // returns false for this combination, so the business host must be matched
    // directly to apply the 'token' prefix. See github/gh-aw#38575.
    expect(copilotTargetRequiresGitHubTokenPrefix('api.business.githubcopilot.com', {
      GITHUB_SERVER_URL: 'https://myorg.ghe.com',
    })).toBe(true);
  });

  it('returns false when an explicit non-GHES AWF_PLATFORM_TYPE overrides the Business host', () => {
    // The explicit platform override is the documented escape hatch and wins
    // even for the Business host, matching isGhesInstance semantics.
    expect(copilotTargetRequiresGitHubTokenPrefix('api.business.githubcopilot.com', {
      AWF_PLATFORM_TYPE: 'ghec',
    })).toBe(false);
  });

  it('returns true for any GHES instance via the GITHUB_SERVER_URL heuristic', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('custom-proxy.internal', {
      GITHUB_SERVER_URL: 'https://ghes.mycompany.com',
    })).toBe(true);
  });

  it('returns false for the standard api.githubcopilot.com endpoint', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('api.githubcopilot.com', {})).toBe(false);
  });

  it('returns false for a *.ghe.com (GHEC) Copilot target', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('copilot-api.myorg.ghe.com', {
      GITHUB_SERVER_URL: 'https://myorg.ghe.com',
    })).toBe(false);
  });

  it('returns false when no token-prefix indicators are present', () => {
    expect(copilotTargetRequiresGitHubTokenPrefix('custom-proxy.internal', {})).toBe(false);
  });
});
