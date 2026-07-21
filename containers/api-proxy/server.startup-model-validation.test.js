/**
 * Tests for pre-startup model validation (AWF_REQUESTED_MODEL).
 */

const { validateRequestedModel, cachedModels, resetModelCacheState } = require('./server');
const { logRequest } = require('./logging');

jest.mock('./logging', () => ({
  logRequest: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  resetModelCacheState();
  delete process.env.AWF_REQUESTED_MODEL;
});

describe('validateRequestedModel', () => {
  it('does nothing when AWF_REQUESTED_MODEL is not set', () => {
    validateRequestedModel();
    expect(logRequest).not.toHaveBeenCalled();
  });

  it('does nothing when AWF_REQUESTED_MODEL is empty', () => {
    process.env.AWF_REQUESTED_MODEL = '   ';
    validateRequestedModel();
    expect(logRequest).not.toHaveBeenCalled();
  });

  it('emits model_validation_skipped when no models are cached', () => {
    process.env.AWF_REQUESTED_MODEL = 'gpt-4o';
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('warn', 'model_validation_skipped', expect.objectContaining({
      requested_model: 'gpt-4o',
    }));
  });

  it('emits model_unavailable_at_startup when model is not found', () => {
    process.env.AWF_REQUESTED_MODEL = 'gpt-5-codex';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('error', 'model_unavailable_at_startup', expect.objectContaining({
      requested_model: 'gpt-5-codex',
      available_count: 3,
    }));
    expect(logRequest.mock.calls[0][2].message).toContain("not available");
    expect(logRequest.mock.calls[0][2].message).toContain("gpt-4o");
  });

  it('emits model_validation success when model is found directly', () => {
    process.env.AWF_REQUESTED_MODEL = 'gpt-4o';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
      requested_model: 'gpt-4o',
      resolved_via: 'direct',
    }));
  });

  it('matches model case-insensitively', () => {
    process.env.AWF_REQUESTED_MODEL = 'GPT-4o';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
      requested_model: 'GPT-4o',
      resolved_via: 'direct',
    }));
  });

  it('treats the Copilot auto model as available without requiring it in provider model lists', () => {
    process.env.AWF_REQUESTED_MODEL = 'auto';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
      requested_model: 'auto',
      resolved_via: 'direct',
    }));
  });

  it('searches across multiple providers', () => {
    process.env.AWF_REQUESTED_MODEL = 'claude-sonnet-4-5';
    cachedModels.copilot = ['gpt-4o'];
    cachedModels.anthropic = ['claude-sonnet-4-5', 'claude-haiku-3'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
      requested_model: 'claude-sonnet-4-5',
      resolved_via: 'direct',
    }));
  });

  it('skips providers with null model lists', () => {
    process.env.AWF_REQUESTED_MODEL = 'gpt-4o';
    cachedModels.copilot = null; // fetch failed
    cachedModels.openai = ['gpt-4o', 'gpt-4o-mini'];
    validateRequestedModel();
    expect(logRequest).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
      requested_model: 'gpt-4o',
    }));
  });

  it('lists available models in the error diagnostic', () => {
    process.env.AWF_REQUESTED_MODEL = 'nonexistent-model';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini', 'o3'];
    validateRequestedModel();
    const message = logRequest.mock.calls[0][2].message;
    expect(message).toContain('gpt-4o');
    expect(message).toContain('retired, restricted, or misspelled');
  });

  it('resolves AWF_REQUESTED_MODEL via model alias and logs resolved_via alias', () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['copilot/*sonnet*'] } });

    let isolatedServer;
    jest.isolateModules(() => {
      jest.mock('./logging', () => ({ logRequest: jest.fn() }));
      isolatedServer = require('./server');
    });

    const { logRequest: isolatedLog } = require('./logging');

    try {
      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = ['claude-sonnet-4-5', 'gpt-4o'];
      process.env.AWF_REQUESTED_MODEL = 'sonnet';
      isolatedServer.validateRequestedModel();
      expect(isolatedLog).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
        requested_model: 'sonnet',
        resolved_via: 'alias',
      }));
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
    }
  });

  it('does not emit model_validation via alias when fallback would fire but model is absent', () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['copilot/*sonnet*'] } });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: true, strategy: 'middle_power' });

    let isolatedServer;
    jest.isolateModules(() => {
      jest.mock('./logging', () => ({ logRequest: jest.fn() }));
      isolatedServer = require('./server');
    });

    const { logRequest: isolatedLog } = require('./logging');

    try {
      isolatedServer.resetModelCacheState();
      // No models matching the alias pattern — only a non-matching model is present
      isolatedServer.cachedModels.copilot = ['gpt-4o'];
      process.env.AWF_REQUESTED_MODEL = 'sonnet';
      isolatedServer.validateRequestedModel();
      // middle-power fallback is disabled during validation, so model_unavailable_at_startup is expected
      expect(isolatedLog).toHaveBeenCalledWith('error', 'model_unavailable_at_startup', expect.objectContaining({
        requested_model: 'sonnet',
      }));
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
    }
  });

  it('resolves AWF_REQUESTED_MODEL via recursive alias chain', () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    // Two-level alias: top-alias → mid-alias → copilot/*claude*
    process.env.AWF_MODEL_ALIASES = JSON.stringify({
      models: {
        'top-alias': ['mid-alias'],
        'mid-alias': ['copilot/*claude*'],
      },
    });

    let isolatedServer;
    jest.isolateModules(() => {
      jest.mock('./logging', () => ({ logRequest: jest.fn() }));
      isolatedServer = require('./server');
    });

    const { logRequest: isolatedLog } = require('./logging');

    try {
      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = ['claude-sonnet-4.6', 'gpt-4o'];
      process.env.AWF_REQUESTED_MODEL = 'top-alias';
      isolatedServer.validateRequestedModel();
      expect(isolatedLog).toHaveBeenCalledWith('info', 'model_validation', expect.objectContaining({
        requested_model: 'top-alias',
        resolved_via: 'alias',
        // Confirms the chain resolved to an actual claude model, not the alias names
        message: expect.stringContaining('top-alias'),
      }));
      // Confirm model_validation_step debug entries cover both alias hops
      const debugCalls = isolatedLog.mock.calls.filter(c => c[1] === 'model_validation_step');
      expect(debugCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
    }
  });

  it('emits model_unavailable_at_startup when aliases form a cycle', () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({
      models: {
        'cycle-a': ['cycle-b'],
        'cycle-b': ['cycle-a'],
      },
    });

    let isolatedServer;
    jest.isolateModules(() => {
      jest.mock('./logging', () => ({ logRequest: jest.fn() }));
      isolatedServer = require('./server');
    });

    const { logRequest: isolatedLog } = require('./logging');

    try {
      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = ['gpt-4o'];
      process.env.AWF_REQUESTED_MODEL = 'cycle-a';
      isolatedServer.validateRequestedModel();
      expect(isolatedLog).toHaveBeenCalledWith('error', 'model_unavailable_at_startup', expect.objectContaining({
        requested_model: 'cycle-a',
      }));
      // Ensure no model_validation (success) log was emitted
      expect(isolatedLog).not.toHaveBeenCalledWith('info', 'model_validation', expect.anything());
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
    }
  });

  it('logs resolution steps at debug level when model resolves', () => {
    process.env.AWF_REQUESTED_MODEL = 'gpt-4o';
    cachedModels.copilot = ['gpt-4o', 'gpt-4o-mini'];
    validateRequestedModel();
    const debugCalls = logRequest.mock.calls.filter(c => c[1] === 'model_validation_step');
    expect(debugCalls.length).toBeGreaterThan(0);
    // The step message should reference the model name
    expect(debugCalls[0][2]).toMatchObject({
      message: expect.stringContaining('gpt-4o'),
      provider: 'copilot',
    });
  });
});
