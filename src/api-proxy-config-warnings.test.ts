import {
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
} from './api-proxy-config-warnings';

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
