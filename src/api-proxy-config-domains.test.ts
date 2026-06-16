import {
  resolveApiTargetsToAllowedDomains,
} from './api-proxy-config-domains';

describe('resolveApiTargetsToAllowedDomains', () => {
  it('should add copilot-api-target option to allowed domains', () => {
    const domains: string[] = ['github.com'];
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'custom.copilot.com' }, domains);
    expect(domains).toContain('custom.copilot.com');
    expect(domains).toContain('https://custom.copilot.com');
  });

  it('should add openai-api-target option to allowed domains', () => {
    const domains: string[] = ['github.com'];
    resolveApiTargetsToAllowedDomains({ openaiApiTarget: 'custom.openai.com' }, domains);
    expect(domains).toContain('custom.openai.com');
    expect(domains).toContain('https://custom.openai.com');
  });

  it('should add anthropic-api-target option to allowed domains', () => {
    const domains: string[] = ['github.com'];
    resolveApiTargetsToAllowedDomains({ anthropicApiTarget: 'custom.anthropic.com' }, domains);
    expect(domains).toContain('custom.anthropic.com');
    expect(domains).toContain('https://custom.anthropic.com');
  });

  it('should prefer option flag over env var', () => {
    const domains: string[] = [];
    const env = { COPILOT_API_TARGET: 'env.copilot.com' };
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'flag.copilot.com' }, domains, env);
    expect(domains).toContain('flag.copilot.com');
    expect(domains).not.toContain('env.copilot.com');
  });

  it('should fall back to env var when option flag is not set', () => {
    const domains: string[] = [];
    const env = { COPILOT_API_TARGET: 'env.copilot.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('env.copilot.com');
    expect(domains).toContain('https://env.copilot.com');
  });

  it('should read OPENAI_API_TARGET from env when flag not set', () => {
    const domains: string[] = [];
    const env = { OPENAI_API_TARGET: 'env.openai.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('env.openai.com');
  });

  it('should read ANTHROPIC_API_TARGET from env when flag not set', () => {
    const domains: string[] = [];
    const env = { ANTHROPIC_API_TARGET: 'env.anthropic.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('env.anthropic.com');
  });

  it('should not duplicate a domain already in the list', () => {
    const domains: string[] = ['custom.copilot.com'];
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'custom.copilot.com' }, domains);
    const count = domains.filter(d => d === 'custom.copilot.com').length;
    expect(count).toBe(1);
  });

  it('should not duplicate the https:// form if already in the list', () => {
    const domains: string[] = ['github.com', 'https://custom.copilot.com'];
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'custom.copilot.com' }, domains);
    const count = domains.filter(d => d === 'https://custom.copilot.com').length;
    expect(count).toBe(1);
  });

  it('should preserve an existing https:// prefix without doubling it', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'https://custom.copilot.com' }, domains);
    expect(domains).toContain('https://custom.copilot.com');
    const count = domains.filter(d => d === 'https://custom.copilot.com').length;
    expect(count).toBe(1);
  });

  it('should handle http:// prefix without adding another https://', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({ openaiApiTarget: 'http://internal.openai.com' }, domains);
    expect(domains).toContain('http://internal.openai.com');
  });

  it('should add all three targets when all are specified', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains(
      {
        copilotApiTarget: 'copilot.internal',
        openaiApiTarget: 'openai.internal',
        anthropicApiTarget: 'anthropic.internal',
      },
      domains
    );
    expect(domains).toContain('copilot.internal');
    expect(domains).toContain('openai.internal');
    expect(domains).toContain('anthropic.internal');
  });

  it('should call debug with auto-added domains', () => {
    const domains: string[] = [];
    const debugMessages: string[] = [];
    resolveApiTargetsToAllowedDomains(
      { copilotApiTarget: 'copilot.internal' },
      domains,
      {},
      (msg) => debugMessages.push(msg)
    );
    expect(debugMessages.some(m => m.includes('copilot.internal'))).toBe(true);
  });

  it('should not call debug when no api targets are set', () => {
    const domains: string[] = [];
    const debugMessages: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, {}, (msg) => debugMessages.push(msg));
    expect(debugMessages).toHaveLength(0);
  });

  it('should return the same allowedDomains array reference', () => {
    const domains: string[] = [];
    const returned = resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'x.com' }, domains);
    expect(returned).toBe(domains);
  });

  it('should ignore empty env var values', () => {
    const domains: string[] = [];
    const env = { COPILOT_API_TARGET: '   ', OPENAI_API_TARGET: '' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toHaveLength(0);
  });

  it('should add gemini-api-target option to allowed domains', () => {
    const domains: string[] = ['github.com'];
    resolveApiTargetsToAllowedDomains({ geminiApiTarget: 'custom.gemini.internal' }, domains);
    expect(domains).toContain('custom.gemini.internal');
    expect(domains).toContain('https://custom.gemini.internal');
  });

  it('should read GEMINI_API_TARGET from env when flag not set', () => {
    const domains: string[] = [];
    const env = { GEMINI_API_TARGET: 'env.gemini.internal' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('env.gemini.internal');
  });

  it('should prefer geminiApiTarget option over GEMINI_API_TARGET env var', () => {
    const domains: string[] = [];
    const env = { GEMINI_API_TARGET: 'env.gemini.internal' };
    resolveApiTargetsToAllowedDomains({ geminiApiTarget: 'flag.gemini.internal' }, domains, env);
    expect(domains).toContain('flag.gemini.internal');
    expect(domains).not.toContain('env.gemini.internal');
  });
});

describe('extractGhesDomainsFromEngineApiTarget (via resolveApiTargetsToAllowedDomains)', () => {
  it('should return no GHES domains when ENGINE_API_TARGET is not set', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, {});
    expect(domains).toHaveLength(0);
  });

  it('should extract GHES domains from api.github.* format', () => {
    const domains: string[] = [];
    const env = { ENGINE_API_TARGET: 'https://api.github.mycompany.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });

  it('should handle non-api.* hostnames', () => {
    const domains: string[] = [];
    const env = { ENGINE_API_TARGET: 'https://github.mycompany.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });

  it('should handle invalid URL gracefully', () => {
    const domains: string[] = [];
    const env = { ENGINE_API_TARGET: 'not-a-valid-url' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toHaveLength(0);
  });

  it('should always include Copilot API domains for GHES', () => {
    const domains: string[] = [];
    const env = { ENGINE_API_TARGET: 'https://api.github.enterprise.local' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });
});

describe('extractGhecDomainsFromServerUrl (via resolveApiTargetsToAllowedDomains)', () => {
  it('should return no GHEC domains when no env vars are set', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, {});
    expect(domains).toHaveLength(0);
  });

  it('should return no GHEC domains when GITHUB_SERVER_URL is github.com', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'https://github.com' });
    expect(domains).toHaveLength(0);
  });

  it('should return no GHEC domains for GHES (non-ghe.com) server URL', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'https://github.mycompany.com' });
    expect(domains).toHaveLength(0);
  });

  it('should extract GHEC tenant, API, Copilot API, and telemetry subdomains from GITHUB_SERVER_URL', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'https://myorg.ghe.com' });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    expect(domains).toContain('copilot-api.myorg.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.myorg.ghe.com');
  });

  it('should handle GITHUB_SERVER_URL with trailing slash', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'https://myorg.ghe.com/' });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    expect(domains).toContain('copilot-api.myorg.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.myorg.ghe.com');
  });

  it('should handle GITHUB_SERVER_URL with path components', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'https://acme.ghe.com/some/path' });
    expect(domains).toContain('acme.ghe.com');
    expect(domains).toContain('api.acme.ghe.com');
    expect(domains).toContain('copilot-api.acme.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.acme.ghe.com');
  });

  it('should extract from GITHUB_API_URL for GHEC', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_API_URL: 'https://api.myorg.ghe.com' });
    expect(domains).toContain('api.myorg.ghe.com');
  });

  it('should not add GITHUB_API_URL domain if already present from GITHUB_SERVER_URL', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, {
      GITHUB_SERVER_URL: 'https://myorg.ghe.com',
      GITHUB_API_URL: 'https://api.myorg.ghe.com',
    });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    const apiCount = domains.filter(d => d === 'api.myorg.ghe.com').length;
    expect(apiCount).toBe(1);
  });

  it('should return no GHEC domains when GITHUB_API_URL is api.github.com', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_API_URL: 'https://api.github.com' });
    expect(domains).toHaveLength(0);
  });

  it('should ignore non-ghe.com GITHUB_API_URL', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_API_URL: 'https://api.github.mycompany.com' });
    expect(domains).toHaveLength(0);
  });

  it('should handle invalid GITHUB_SERVER_URL gracefully', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_SERVER_URL: 'not-a-valid-url' });
    expect(domains).toHaveLength(0);
  });

  it('should handle invalid GITHUB_API_URL gracefully', () => {
    const domains: string[] = [];
    resolveApiTargetsToAllowedDomains({}, domains, { GITHUB_API_URL: 'not-a-valid-url' });
    expect(domains).toHaveLength(0);
  });
});

describe('resolveApiTargetsToAllowedDomains with GHEC', () => {
  it('should auto-add GHEC domains when GITHUB_SERVER_URL is a ghe.com tenant', () => {
    const domains: string[] = [];
    const env = { GITHUB_SERVER_URL: 'https://myorg.ghe.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    expect(domains).toContain('copilot-api.myorg.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.myorg.ghe.com');
  });

  it('should not duplicate GHEC domains if already in allowlist', () => {
    const domains: string[] = ['myorg.ghe.com', 'api.myorg.ghe.com'];
    const env = { GITHUB_SERVER_URL: 'https://myorg.ghe.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    const tenantCount = domains.filter(d => d === 'myorg.ghe.com').length;
    const apiCount = domains.filter(d => d === 'api.myorg.ghe.com').length;
    expect(tenantCount).toBe(1);
    expect(apiCount).toBe(1);
  });

  it('should not add GHEC domains for public github.com', () => {
    const initialLength = 0;
    const domains: string[] = [];
    const env = { GITHUB_SERVER_URL: 'https://github.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).not.toContain('github.com');
    expect(domains).not.toContain('api.github.com');
    expect(domains).toHaveLength(initialLength);
  });

  it('should auto-add GHEC domain from GITHUB_API_URL', () => {
    const domains: string[] = [];
    const env = { GITHUB_API_URL: 'https://api.myorg.ghe.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('api.myorg.ghe.com');
  });

  it('should combine GHEC domains with explicit API target', () => {
    const domains: string[] = [];
    const env = { GITHUB_SERVER_URL: 'https://company.ghe.com' };
    resolveApiTargetsToAllowedDomains({ copilotApiTarget: 'api.company.ghe.com' }, domains, env);
    expect(domains).toContain('company.ghe.com');
    expect(domains).toContain('api.company.ghe.com');
  });
});

describe('resolveApiTargetsToAllowedDomains with GHES', () => {
  it('should auto-add GHES domains when ENGINE_API_TARGET is set', () => {
    const domains: string[] = ['github.com'];
    const env = { ENGINE_API_TARGET: 'https://api.github.mycompany.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });

  it('should not duplicate GHES domains if already in allowlist', () => {
    const domains: string[] = ['github.mycompany.com', 'api.githubcopilot.com'];
    const env = { ENGINE_API_TARGET: 'https://api.github.mycompany.com' };
    resolveApiTargetsToAllowedDomains({}, domains, env);
    const ghesCount = domains.filter(d => d === 'github.mycompany.com').length;
    const copilotCount = domains.filter(d => d === 'api.githubcopilot.com').length;
    expect(ghesCount).toBe(1);
    expect(copilotCount).toBe(1);
  });

  it('should combine GHES domains with API target domains', () => {
    const domains: string[] = [];
    const env = { ENGINE_API_TARGET: 'https://api.github.mycompany.com' };
    resolveApiTargetsToAllowedDomains(
      { copilotApiTarget: 'custom.copilot.com' },
      domains,
      env
    );
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
    expect(domains).toContain('custom.copilot.com');
    expect(domains).toContain('https://custom.copilot.com');
  });
});
