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
});
