'use strict';

const { lookupModelRoutingMetadata } = require('./model-api-mapping');
const { resolveModelReasoning, getModelReasoning, getRequestReasoning, assessReasoningEffort } = require('./model-reasoning');
const { normalizeModel } = require('./routing-catalogue');
const { getModelRoutingChoices } = require('./routing-candidates');
const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');

const miniEfforts = ['none', 'low', 'medium', 'high', 'xhigh'];

afterEach(() => clearRuntimeModels());

describe('reviewed native exact-model reasoning and context', () => {
  test.each(['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'])('%s has independently reviewed mini facts', model => {
    expect(lookupModelRoutingMetadata(model, 'openai')).toMatchObject({
      reasoningEfforts: miniEfforts, contextWindowTokens: 400_000,
    });
    const decision = resolveModelReasoning(model, 'openai', { records: [] });
    const normalized = normalizeModel(model, undefined, 'openai');
    expect(getModelReasoning(normalized, 'openai')).toEqual(decision);
    expect(normalized.contextWindow).toBe(400_000);
    expect(decision).toMatchObject({
      support: 'supported', mode: 'optional', default: 'none', selectableEfforts: miniEfforts,
    });
    expect(getModelRoutingChoices(normalized, 'openai')).toEqual(
      miniEfforts.map(effort => ({ effort, protocol: 'responses' })),
    );
    for (const effort of miniEfforts) {
      const body = Buffer.from(JSON.stringify({ model, reasoning: { effort } }));
      const original = Buffer.from(body);
      expect(() => validateReasoningEffort(body, 'openai', '/v1/responses', {})).not.toThrow();
      expect(body).toEqual(original);
      expect(assessReasoningEffort(decision, effort, { automatic: true }).admitted).toBe(true);
    }
    for (const effort of ['minimal', 'max', 'future']) {
      expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
        model, reasoning: { effort },
      })), 'openai', '/v1/responses', {})).toThrow(expect.objectContaining({
        code: 'unsupported_reasoning_effort', statusCode: 400,
      }));
      expect(assessReasoningEffort(decision, effort, { automatic: true }).admitted).toBe(false);
    }
    const omitted = Buffer.from(JSON.stringify({ model, input: 'hello' }));
    expect(() => validateReasoningEffort(omitted, 'openai', '/v1/responses', {})).not.toThrow();
    expect(JSON.parse(omitted)).not.toHaveProperty('reasoning');
    expect(assessReasoningEffort(decision, undefined, { automatic: true }).admitted).toBe(true);
  });

  test.each([
    'gpt-5.4-pro', 'gpt-5.4-nano', 'gpt-5.4-mini-pro', 'gpt-5.4-mini-cyber',
    'gpt-5.4-mini-research', 'gpt-5.4-mini-preview', 'gpt-5.4-mini-nano',
    'gpt-5.4-mini-2099-01-01', 'gpt-5.4-2099-01-01',
    'gpt-5.5-pro', 'gpt-5.6-cyber',
  ])('%s cannot borrow base or mini routing facts', model => {
    expect(lookupModelRoutingMetadata(model, 'openai')).toBeNull();
    const normalized = normalizeModel(model, undefined, 'openai');
    expect(normalized).not.toHaveProperty('contextWindow');
    expect(getModelRoutingChoices(normalized, 'openai')).toEqual([]);
    const decision = resolveModelReasoning(model, 'openai', { records: [] });
    expect(decision.support).toBe('absent');
    expect(assessReasoningEffort(decision, 'future').admitted).toBe(true);
    expect(assessReasoningEffort(decision, 'high', { automatic: true }).admitted).toBe(false);
  });

  test.each([
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('%s uses revision-specific native evidence', (model, efforts) => {
    const normalized = normalizeModel(model, undefined, 'anthropic');
    const decision = getModelReasoning(normalized, 'anthropic');
    expect(decision).toMatchObject({
      support: 'supported', mode: 'optional', default: 'high', selectableEfforts: efforts,
    });
    expect(normalized.contextWindow).toBe(1_000_000);
    expect(getModelRoutingChoices(normalized, 'anthropic')).toEqual(
      efforts.map(effort => ({ effort, protocol: 'messages' })),
    );
    for (const effort of [...efforts, undefined]) {
      const body = Buffer.from(JSON.stringify({ model, max_tokens: 1024, output_config: { effort } }));
      const original = Buffer.from(body);
      expect(() => validateReasoningEffort(body, 'anthropic', '/v1/messages', {})).not.toThrow();
      expect(body).toEqual(original);
    }
    for (const effort of ['none', 'minimal', 'future', ...(model.endsWith('-6') ? ['xhigh'] : [])]) {
      expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
        model, output_config: { effort },
      })), 'anthropic', '/v1/messages', {})).toThrow(expect.objectContaining({
        code: 'unsupported_reasoning_effort',
      }));
    }
  });

  test.each([
    'claude-opus-4-6-20990101', 'claude-opus-4-7-20990101', 'claude-opus-4-8-20990101',
    'claude-opus-4-9', 'claude-opus-4-8-preview', 'claude-opus-4-8-fast',
    'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6',
  ])('%s has no newly inferred native alias or revision', model => {
    expect(lookupModelRoutingMetadata(model, 'anthropic')).toBeNull();
    expect(resolveModelReasoning(model, 'anthropic', { records: [] }).support).toBe('absent');
    expect(getModelRoutingChoices(normalizeModel(model, undefined, 'anthropic'), 'anthropic')).toEqual([]);
  });

  test('unreviewed active models retain unknown mode/default and provider observations override maintained lists', () => {
    const base = resolveModelReasoning('gpt-5.4', 'openai', { records: [] });
    expect(base.mode).toBe('unknown');
    expect(base).not.toHaveProperty('default');
    const unknown = resolveModelReasoning('gpt-5.4-mini', 'openai', {
      records: [{ id: 'gpt-5.4-mini', supportedReasoningEfforts: 'unverified' }],
    });
    expect(unknown).toMatchObject({ support: 'unknown', mode: 'unknown', selectableEfforts: [] });
    expect(unknown).not.toHaveProperty('default');
    expect(assessReasoningEffort(unknown, 'high').admitted).toBe(true);
    expect(assessReasoningEffort(unknown, 'high', { automatic: true }).admitted).toBe(false);
    const forbidden = resolveModelReasoning('gpt-5.4-mini', 'openai', {
      records: [{ id: 'gpt-5.4-mini', supportedReasoningEfforts: [] }],
    });
    expect(forbidden).toMatchObject({ support: 'unsupported', mode: 'forbidden' });
    expect(forbidden).not.toHaveProperty('default');
    expect(assessReasoningEffort(forbidden, 'high').admitted).toBe(false);
  });

  test.each(['copilot', 'openrouter', 'anthropic'])('mini facts do not cross into %s', provider => {
    const normalized = normalizeModel('gpt-5.4-mini', undefined, provider);
    expect(getModelReasoning(normalized, provider).support).toBe('absent');
    expect(normalized).not.toHaveProperty('contextWindow');
    expect(getModelRoutingChoices(normalized, provider)).toEqual([]);
  });

  test.each([
    ['gpt-5.4', { provider: 'openai', channel: 'native-api', deployment: 'custom' }],
    ['gpt-5.4-mini', { provider: 'openai', channel: 'native-api', deployment: 'custom' }],
    ['gpt-5.4-mini', { provider: 'openai', channel: 'copilot-api' }],
  ])('%s native reasoning and context do not leak into scope %j', (model, scope) => {
    const normalized = normalizeModel(model, undefined, 'openai', scope);
    expect(getModelReasoning(normalized, 'openai').support).toBe('absent');
    expect(normalized).not.toHaveProperty('contextWindow');
    const observed = normalizeModel(model, {
      capabilities: { limits: { max_context_window_tokens: 12345 } },
    }, 'openai', scope);
    expect(observed.contextWindow).toBe(12345);
  });

  test('request and selection pins survive provider refresh without changing maintained facts', () => {
    const model = 'gpt-5.4-mini';
    const req = {};
    const pinned = getRequestReasoning(model, 'openai', {}, req);
    const selected = normalizeModel(model, undefined, 'openai');
    replaceRuntimeModels('openai', [{ id: model, supportedReasoningEfforts: ['low'] }]);
    expect(getRequestReasoning(model, 'openai', undefined, req)).toBe(pinned);
    expect(getModelReasoning(selected, 'openai')).toEqual(pinned);
    expect(getRequestReasoning(model, 'openai').supportedEfforts).toEqual(['low']);
    expect(getRequestReasoning(model, 'openai', undefined, { awfReasoning: pinned })).toBe(pinned);
    expect(selected.contextWindow).toBe(400_000);
  });
});
