import type { ApiProxyOptions } from './api-proxy-options';

describe('ApiProxyOptions', () => {
  it('composes fields from credential, routing, model, and diagnostics options', () => {
    const options: ApiProxyOptions = {
      enableApiProxy: true,
      openaiApiKey: 'test-key',
      openaiApiTarget: 'api.openai.com',
      modelAliases: { default: ['openai/*'] },
      debugTokens: true,
    };

    expect(options.enableApiProxy).toBe(true);
    expect(options.openaiApiTarget).toBe('api.openai.com');
    expect(options.modelAliases).toEqual({ default: ['openai/*'] });
    expect(options.debugTokens).toBe(true);
  });
});
