import {
  validateApiProxyConfig,
  validateAnthropicCacheTailTtl,
  validateApiTargetInAllowedDomains,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
  resolveApiTargetsToAllowedDomains,
  extractGhesDomainsFromEngineApiTarget,
  extractGhecDomainsFromServerUrl,
} from './api-proxy-config';

describe('validateApiProxyConfig', () => {
  it('should return disabled when enableApiProxy is false', () => {
    const result = validateApiProxyConfig(false);
    expect(result.enabled).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toEqual([]);
  });

  it('should warn when enabled but no API keys provided', () => {
    const result = validateApiProxyConfig(true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('no API keys found');
    expect(result.warnings[1]).toContain('OPENAI_API_KEY');
    expect(result.warnings[1]).toContain('ANTHROPIC_API_KEY');
    expect(result.warnings[1]).toContain('COPILOT_GITHUB_TOKEN');
    expect(result.warnings[1]).toContain('COPILOT_API_KEY');
    expect(result.warnings[1]).toContain('GEMINI_API_KEY');
    expect(result.debugMessages).toEqual([]);
  });

  it('should warn when enabled with undefined keys', () => {
    const result = validateApiProxyConfig(true, undefined, undefined);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it('should detect OpenAI key', () => {
    const result = validateApiProxyConfig(true, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('OpenAI');
  });

  it('should detect Anthropic key', () => {
    const result = validateApiProxyConfig(true, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Anthropic');
  });

  it('should detect Copilot key', () => {
    const result = validateApiProxyConfig(true, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Copilot');
  });

  it('should detect Gemini key', () => {
    const result = validateApiProxyConfig(true, false, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Gemini');
  });

  it('should detect all four keys', () => {
    const result = validateApiProxyConfig(true, true, true, true, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(4);
    expect(result.debugMessages[0]).toContain('OpenAI');
    expect(result.debugMessages[1]).toContain('Anthropic');
    expect(result.debugMessages[2]).toContain('Copilot');
    expect(result.debugMessages[3]).toContain('Gemini');
  });

  it('should not warn when disabled even with keys', () => {
    const result = validateApiProxyConfig(false, true, true);
    expect(result.enabled).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toEqual([]);
  });

  it('should detect mixed key combination (OpenAI + Gemini)', () => {
    const result = validateApiProxyConfig(true, true, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(2);
    expect(result.debugMessages[0]).toContain('OpenAI');
    expect(result.debugMessages[1]).toContain('Gemini');
  });
});

describe('validateApiTargetInAllowedDomains', () => {
  it('should return null when using the default host', () => {
    const result = validateApiTargetInAllowedDomains(
      'api.openai.com',
      'api.openai.com',
      '--openai-api-target',
      ['example.com']
    );
    expect(result).toBeNull();
  });

  it('should return null when custom host is in allowed domains', () => {
    const result = validateApiTargetInAllowedDomains(
      'custom.example.com',
      'api.openai.com',
      '--openai-api-target',
      ['custom.example.com', 'other.com']
    );
    expect(result).toBeNull();
  });

  it('should return null when custom host matches a parent domain in allowed list', () => {
    const result = validateApiTargetInAllowedDomains(
      'llm-router.internal.example.com',
      'api.openai.com',
      '--openai-api-target',
      ['example.com']
    );
    expect(result).toBeNull();
  });

  it('should return null when custom host matches a dotted parent domain in allowed list', () => {
    const result = validateApiTargetInAllowedDomains(
      'api.example.com',
      'api.openai.com',
      '--openai-api-target',
      ['.example.com']
    );
    expect(result).toBeNull();
  });

  it('should return a warning when custom host is not in allowed domains', () => {
    const result = validateApiTargetInAllowedDomains(
      'custom.llm-router.internal',
      'api.openai.com',
      '--openai-api-target',
      ['github.com', 'api.openai.com']
    );
    expect(result).not.toBeNull();
    expect(result).toContain('--openai-api-target=custom.llm-router.internal');
    expect(result).toContain('--allow-domains');
  });

  it('should return a warning with the correct flag name and host', () => {
    const result = validateApiTargetInAllowedDomains(
      'custom.anthropic-router.com',
      'api.anthropic.com',
      '--anthropic-api-target',
      []
    );
    expect(result).not.toBeNull();
    expect(result).toContain('--anthropic-api-target=custom.anthropic-router.com');
  });

  it('should return null when allowed domains list is empty and using default host', () => {
    const result = validateApiTargetInAllowedDomains(
      'api.anthropic.com',
      'api.anthropic.com',
      '--anthropic-api-target',
      []
    );
    expect(result).toBeNull();
  });
});

describe('emitApiProxyTargetWarnings', () => {
  it('should emit no warnings when api proxy is disabled', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: false, openaiApiTarget: 'custom.example.com', anthropicApiTarget: 'custom2.example.com' },
      ['other.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should emit no warnings when api proxy is not set', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      {},
      ['other.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should emit no warnings when using default targets', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should emit warning for custom OpenAI target not in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'custom.openai-router.internal' },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--openai-api-target=custom.openai-router.internal');
  });

  it('should emit warning for custom Anthropic target not in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, anthropicApiTarget: 'custom.anthropic-router.internal' },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--anthropic-api-target=custom.anthropic-router.internal');
  });

  it('should emit warnings for both custom targets when neither is in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'openai.internal', anthropicApiTarget: 'anthropic.internal' },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('--openai-api-target=openai.internal');
    expect(warnings[1]).toContain('--anthropic-api-target=anthropic.internal');
  });

  it('should emit no warnings when custom targets are in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'openai.example.com', anthropicApiTarget: 'anthropic.example.com' },
      ['example.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should use default targets when openaiApiTarget and anthropicApiTarget are undefined', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: undefined, anthropicApiTarget: undefined },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    // Default targets are not in 'github.com' allowed domains, but since they ARE the defaults,
    // validateApiTargetInAllowedDomains returns null for default==default check
    expect(warnings).toHaveLength(0);
  });

  it('should emit warning for custom Copilot target not in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, copilotApiTarget: 'custom.copilot-router.internal' },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--copilot-api-target=custom.copilot-router.internal');
  });

  it('should emit no warnings when custom Copilot target is in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, copilotApiTarget: 'copilot.example.com' },
      ['example.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should emit warnings for all three custom targets when none are in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      {
        enableApiProxy: true,
        openaiApiTarget: 'openai.internal',
        anthropicApiTarget: 'anthropic.internal',
        copilotApiTarget: 'copilot.internal'
      },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('--openai-api-target=openai.internal');
    expect(warnings[1]).toContain('--anthropic-api-target=anthropic.internal');
    expect(warnings[2]).toContain('--copilot-api-target=copilot.internal');
  });

  it('should emit warning for custom Gemini target not in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, geminiApiTarget: 'custom.gemini-router.internal' },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('--gemini-api-target=custom.gemini-router.internal');
  });

  it('should emit no warnings when custom Gemini target is in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, geminiApiTarget: 'gemini.example.com' },
      ['example.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(0);
  });

  it('should use default Gemini target when geminiApiTarget is undefined', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, geminiApiTarget: undefined },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    // Default target is not in 'github.com' but since it IS the default, no warning is emitted
    expect(warnings).toHaveLength(0);
  });

  it('should emit warnings for all four custom targets when none are in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      {
        enableApiProxy: true,
        openaiApiTarget: 'openai.internal',
        anthropicApiTarget: 'anthropic.internal',
        copilotApiTarget: 'copilot.internal',
        geminiApiTarget: 'gemini.internal',
      },
      ['github.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings).toHaveLength(4);
    expect(warnings[3]).toContain('--gemini-api-target=gemini.internal');
  });
});

describe('emitCliProxyStatusLogs', () => {
  it('should emit nothing when difcProxyHost is not set', () => {
    const infos: string[] = [];
    const warns: string[] = [];
    emitCliProxyStatusLogs(
      { githubToken: 'tok' },
      (msg) => infos.push(msg),
      (msg) => warns.push(msg),
    );
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('should emit nothing when difcProxyHost is undefined', () => {
    const infos: string[] = [];
    const warns: string[] = [];
    emitCliProxyStatusLogs(
      {},
      (msg) => infos.push(msg),
      (msg) => warns.push(msg),
    );
    expect(infos).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('should emit info when difcProxyHost is set with token', () => {
    const infos: string[] = [];
    const warns: string[] = [];
    emitCliProxyStatusLogs(
      { difcProxyHost: 'host.docker.internal:18443', githubToken: 'ghp_test123' },
      (msg) => infos.push(msg),
      (msg) => warns.push(msg),
    );
    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(infos[0]).toContain('CLI proxy enabled');
    expect(infos[0]).toContain('host.docker.internal:18443');
    expect(warns).toHaveLength(0);
  });

  it('should emit warnings when token is missing', () => {
    const infos: string[] = [];
    const warns: string[] = [];
    emitCliProxyStatusLogs(
      { difcProxyHost: 'host.docker.internal:18443' },
      (msg) => infos.push(msg),
      (msg) => warns.push(msg),
    );
    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns[0]).toContain('no GitHub token found');
  });
});

describe('warnClassicPATWithCopilotModel', () => {
  it('should emit warnings when classic PAT and COPILOT_MODEL are both set', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(true, true, (msg) => warns.push(msg));
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain('COPILOT_MODEL');
    expect(warns.some(w => w.includes('classic PAT'))).toBe(true);
  });

  it('should not warn when token is not a classic PAT', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(false, true, (msg) => warns.push(msg));
    expect(warns).toHaveLength(0);
  });

  it('should not warn when COPILOT_MODEL is not set', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(true, false, (msg) => warns.push(msg));
    expect(warns).toHaveLength(0);
  });

  it('should not warn when neither condition holds', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(false, false, (msg) => warns.push(msg));
    expect(warns).toHaveLength(0);
  });

  it('should mention /models endpoint in warning', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(true, true, (msg) => warns.push(msg));
    expect(warns.some(w => w.includes('/models'))).toBe(true);
  });

  it('should mention exit code 1 in warning', () => {
    const warns: string[] = [];
    warnClassicPATWithCopilotModel(true, true, (msg) => warns.push(msg));
    expect(warns.some(w => w.includes('exit code 1'))).toBe(true);
  });
});

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
    // Whitespace-only and empty values are filtered out
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

describe('validateAnthropicCacheTailTtl', () => {
  it('should not call process.exit when value is undefined', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    validateAnthropicCacheTailTtl(undefined);
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should not call process.exit for valid value "5m"', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    validateAnthropicCacheTailTtl('5m');
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should not call process.exit for valid value "1h"', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    validateAnthropicCacheTailTtl('1h');
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should call process.exit(1) for an invalid value', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});
    validateAnthropicCacheTailTtl('10m');
    expect(mockError).toHaveBeenCalledWith('Invalid --anthropic-cache-tail-ttl value: "10m". Must be "5m" or "1h".');
    expect(mockExit).toHaveBeenCalledWith(1);
    mockError.mockRestore();
    mockExit.mockRestore();
  });
});

describe('extractGhesDomainsFromEngineApiTarget', () => {
  it('should return empty array when ENGINE_API_TARGET is not set', () => {
    const domains = extractGhesDomainsFromEngineApiTarget({});
    expect(domains).toEqual([]);
  });

  it('should use process.env by default when no env argument is provided', () => {
    const saved = process.env.ENGINE_API_TARGET;
    delete process.env.ENGINE_API_TARGET;
    const domains = extractGhesDomainsFromEngineApiTarget();
    expect(domains).toEqual([]);
    if (saved !== undefined) process.env.ENGINE_API_TARGET = saved;
  });

  it('should extract GHES domains from api.github.* format', () => {
    const env = { ENGINE_API_TARGET: 'https://api.github.mycompany.com' };
    const domains = extractGhesDomainsFromEngineApiTarget(env);
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });

  it('should handle non-api.* hostnames', () => {
    const env = { ENGINE_API_TARGET: 'https://github.mycompany.com' };
    const domains = extractGhesDomainsFromEngineApiTarget(env);
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });

  it('should handle invalid URL gracefully', () => {
    const env = { ENGINE_API_TARGET: 'not-a-valid-url' };
    const domains = extractGhesDomainsFromEngineApiTarget(env);
    expect(domains).toEqual([]);
  });

  it('should always include Copilot API domains for GHES', () => {
    const env = { ENGINE_API_TARGET: 'https://api.github.enterprise.local' };
    const domains = extractGhesDomainsFromEngineApiTarget(env);
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
  });
});

describe('extractGhecDomainsFromServerUrl', () => {
  it('should return empty array when no env vars are set', () => {
    const domains = extractGhecDomainsFromServerUrl({});
    expect(domains).toEqual([]);
  });

  it('should return empty array when GITHUB_SERVER_URL is github.com', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'https://github.com' });
    expect(domains).toEqual([]);
  });

  it('should return empty array for GHES (non-ghe.com) server URL', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'https://github.mycompany.com' });
    expect(domains).toEqual([]);
  });

  it('should extract GHEC tenant, API, Copilot API, and telemetry subdomains from GITHUB_SERVER_URL', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'https://myorg.ghe.com' });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    expect(domains).toContain('copilot-api.myorg.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.myorg.ghe.com');
    expect(domains).toHaveLength(4);
  });

  it('should handle GITHUB_SERVER_URL with trailing slash', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'https://myorg.ghe.com/' });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    expect(domains).toContain('copilot-api.myorg.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.myorg.ghe.com');
  });

  it('should handle GITHUB_SERVER_URL with path components', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'https://acme.ghe.com/some/path' });
    expect(domains).toContain('acme.ghe.com');
    expect(domains).toContain('api.acme.ghe.com');
    expect(domains).toContain('copilot-api.acme.ghe.com');
    expect(domains).toContain('copilot-telemetry-service.acme.ghe.com');
  });

  it('should extract from GITHUB_API_URL for GHEC', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_API_URL: 'https://api.myorg.ghe.com' });
    expect(domains).toContain('api.myorg.ghe.com');
  });

  it('should not add GITHUB_API_URL domain if already present from GITHUB_SERVER_URL', () => {
    const domains = extractGhecDomainsFromServerUrl({
      GITHUB_SERVER_URL: 'https://myorg.ghe.com',
      GITHUB_API_URL: 'https://api.myorg.ghe.com',
    });
    expect(domains).toContain('myorg.ghe.com');
    expect(domains).toContain('api.myorg.ghe.com');
    // api.myorg.ghe.com should appear only once
    const apiCount = domains.filter(d => d === 'api.myorg.ghe.com').length;
    expect(apiCount).toBe(1);
  });

  it('should return empty array when GITHUB_API_URL is api.github.com', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_API_URL: 'https://api.github.com' });
    expect(domains).toEqual([]);
  });

  it('should ignore non-ghe.com GITHUB_API_URL', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_API_URL: 'https://api.github.mycompany.com' });
    expect(domains).toEqual([]);
  });

  it('should handle invalid GITHUB_SERVER_URL gracefully', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_SERVER_URL: 'not-a-valid-url' });
    expect(domains).toEqual([]);
  });

  it('should handle invalid GITHUB_API_URL gracefully', () => {
    const domains = extractGhecDomainsFromServerUrl({ GITHUB_API_URL: 'not-a-valid-url' });
    expect(domains).toEqual([]);
  });

  it('should use process.env by default when no env argument is provided', () => {
    const savedServerUrl = process.env.GITHUB_SERVER_URL;
    const savedApiUrl = process.env.GITHUB_API_URL;
    delete process.env.GITHUB_SERVER_URL;
    delete process.env.GITHUB_API_URL;
    const domains = extractGhecDomainsFromServerUrl();
    expect(domains).toEqual([]);
    if (savedServerUrl !== undefined) process.env.GITHUB_SERVER_URL = savedServerUrl;
    if (savedApiUrl !== undefined) process.env.GITHUB_API_URL = savedApiUrl;
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
    // github.com itself should NOT be auto-added just from GITHUB_SERVER_URL
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
    // GHES domains
    expect(domains).toContain('github.mycompany.com');
    expect(domains).toContain('api.github.mycompany.com');
    // Copilot API domains
    expect(domains).toContain('api.githubcopilot.com');
    expect(domains).toContain('api.enterprise.githubcopilot.com');
    expect(domains).toContain('telemetry.enterprise.githubcopilot.com');
    // Custom API target
    expect(domains).toContain('custom.copilot.com');
    expect(domains).toContain('https://custom.copilot.com');
  });
});
