'use strict';

const {
  parseProviderModelMetadata, replaceRuntimeModels, clearRuntimeModels, captureRuntimePricing,
} = require('./runtime-model-catalog');
const {
  resolveModelReasoning, getModelReasoning, getRequestReasoning, assessReasoningEffort,
  getReasoningScope,
} = require('./model-reasoning');
const { normalizeModel } = require('./routing-catalogue');
const { getModelRoutingChoices, buildRoutingCandidates } = require('./routing-candidates');
const { validateReasoningEffort } = require('./reasoning-effort-validation');

const body = (model, effort = 'future') => Buffer.from(JSON.stringify({ model, reasoning_effort: effort }));
afterEach(() => clearRuntimeModels());

describe('shared direct and routing reasoning adapters', () => {
  it.each([
    [{ supportedReasoningEfforts: ['max'], capabilities: { supports: { reasoning_effort: ['low'], reasoningEffort: false } } }, ['max']],
    [{ capabilities: { supports: { reasoning_effort: ['none'], reasoningEffort: false } } }, ['none']],
    [{ capabilities: { supports: { reasoningEffort: false } } }, []],
    [{ capabilities: { supports: { streaming: true } } }, []],
    [{ capabilities: { supports: { reasoning_effort: 'low' } } }, undefined],
    [{}, undefined],
  ])('characterizes runtime precedence without an independent routing table: %j', (metadata, efforts) => {
    const record = { id: 'exact-test', ...metadata };
    const catalog = { copilot: [record] };
    const normalized = normalizeModel(record.id, record, 'copilot');
    const direct = getRequestReasoning(record.id, 'copilot', catalog);
    expect(getModelReasoning(normalized, 'copilot')).toEqual(direct);
    expect(normalized.efforts).toEqual(efforts);
    if (efforts === undefined) {
      expect(() => validateReasoningEffort(body(record.id), 'copilot', '/chat/completions', catalog)).not.toThrow();
    } else {
      expect(() => validateReasoningEffort(body(record.id), 'copilot', '/chat/completions', catalog))
        .toThrow(expect.objectContaining({ code: 'unsupported_reasoning_effort' }));
    }
  });

  it('keeps observed future values and their provenance but never automatically selects them', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{ id: 'exact-test', supportedReasoningEfforts: ['none', 'max', 'future'],
        supported_endpoints: ['/responses'] }],
    }, { observedAt: '2026-11-01T00:00:00Z', apiVersion: 'fixture-version' });
    const normalized = normalizeModel('exact-test', records[0], 'copilot');
    expect(getModelRoutingChoices(normalized, 'copilot')).toEqual([
      { effort: 'none', protocol: 'responses' }, { effort: 'max', protocol: 'responses' },
    ]);
    expect(getModelReasoning(normalized, 'copilot').observations[0]).toMatchObject({
      rawEfforts: ['none', 'max', 'future'],
      provenance: { at: '2026-11-01T00:00:00Z', apiVersion: 'fixture-version' },
    });
    const catalog = { copilot: records };
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
      model: 'exact-test', reasoning: { effort: 'future' },
    })), 'copilot', '/responses',
      catalog)).not.toThrow();
    expect(() => validateReasoningEffort(body('exact-test'), 'copilot', '/chat/completions',
      catalog)).not.toThrow();
  });

  it('uses reviewed scoped aliases, not same-slug backends or broad date normalization', () => {
    const records = [{ id: 'claude-opus-4-8', supportedReasoningEfforts: ['max'] }];
    expect(resolveModelReasoning('claude-opus-4-8-20990101', 'copilot', { records }).support).toBe('absent');
    expect(resolveModelReasoning('claude-opus-4-8', 'openrouter', {
      records: records.map(record => ({ ...record, provider: 'copilot' })),
    }).support).toBe('absent');
    const scoped = records.map(record => ({ ...record, scope: {
      provider: 'copilot', channel: 'copilot-api', deployment: 'enterprise-a',
    } }));
    expect(resolveModelReasoning('claude-opus-4-8', 'copilot', { records: scoped }).support).toBe('absent');
    expect(resolveModelReasoning('claude-opus-4-8', 'copilot', {
      records: scoped, scope: scoped[0].scope,
    }).support).toBe('supported');
    for (const scope of [{ deployment: 'other-enterprise' }, { channel: 'native-api' }]) {
      expect(resolveModelReasoning('claude-opus-4-8', 'copilot', { records, scope }).support).toBe('absent');
    }
  });

  it('does not inherit reasoning evidence from a reviewed accounting-family sibling', () => {
    const records = [{ id: 'gpt-5.4', supportedReasoningEfforts: ['high'] }];
    const sibling = resolveModelReasoning('gpt-5.4', 'copilot', { records });
    const exact = resolveModelReasoning('gpt-5.4-mini', 'copilot', { records });
    expect(exact.identity.family).toBe(sibling.identity.family);
    expect(exact.identity.key).not.toBe(sibling.identity.key);
    expect(sibling.support).toBe('supported');
    expect(exact.support).toBe('absent');
    expect(exact.supportedEfforts).toEqual([]);
    expect(assessReasoningEffort(exact, 'future').admitted).toBe(true);
    expect(assessReasoningEffort(exact, 'high', { automatic: true }).admitted).toBe(false);
    const observed = resolveModelReasoning('gpt-5.4-mini', 'copilot', {
      records: [...records, { id: 'gpt-5.4-mini', supportedReasoningEfforts: ['low'] }],
    });
    expect(observed.supportedEfforts).toEqual(['low']);
    expect(assessReasoningEffort(observed, 'high').admitted).toBe(false);
  });

  it('reuses scoped alias resolution and raw exact-ID precedence for captured facts', () => {
    const { identity } = require('./catalogue-contract/identity');
    const scope = { provider: 'copilot', channel: 'copilot-api' };
    jest.isolateModules(() => {
      jest.doMock('./model-information.naming.generated.json', () => ({
        models: [{ identity: {
          ...identity('copilot', 'exact'),
          aliases: [{ id: 'reviewed-alias', match: 'exact', scope }],
        } }],
      }));
      const resolve = require('./model-reasoning').resolveModelReasoning;
      const records = [{ id: 'exact', supportedReasoningEfforts: ['max'] }];
      expect(resolve('reviewed-alias', 'copilot', { records }).supportedEfforts).toEqual(['max']);
      expect(resolve('reviewed-alias', 'copilot', { records, scope: {
        ...scope, deployment: 'custom',
      } }).support).toBe('absent');
      expect(resolve('reviewed-alias', 'openai', { records }).support).toBe('absent');
    });
    jest.dontMock('./model-information.naming.generated.json');
    jest.isolateModules(() => {
      jest.doMock('./model-information.naming.generated.json', () => ({
        models: [
          { identity: { ...identity('copilot', 'exact'),
            aliases: [{ id: 'literal', match: 'exact', scope }] } },
        ],
      }));
      const resolve = require('./model-reasoning').resolveModelReasoning;
      expect(resolve('literal', 'copilot', { records: [
        { id: 'exact', supportedReasoningEfforts: ['max'] },
        { id: 'literal', supportedReasoningEfforts: [] },
      ] }).support).toBe('unsupported');
    });
    jest.dontMock('./model-information.naming.generated.json');
  });

  it.each([
    ['gpt-5.4', 'openai', 'supported'],
    ['gpt-5.4-mini', 'openai', 'absent'],
    ['gpt-5.5-pro', 'openai', 'absent'],
    ['gpt-5.6-sol', 'openai', 'absent'],
    ['claude-opus-4-6', 'anthropic', 'supported'],
    ['claude-opus-4-7', 'anthropic', 'supported'],
    ['claude-opus-4-8', 'anthropic', 'supported'],
    ['claude-fable-5-1', 'anthropic', 'supported'],
    ['claude-mythos-5-1', 'anthropic', 'supported'],
    ['claude-mythos-preview', 'anthropic', 'supported'],
    ['claude-haiku-5-5', 'anthropic', 'absent'],
    ['gpt-5.4', 'copilot', 'absent'],
  ])('uses only reviewed active evidence for specialized %s on %s', (model, provider, support) => {
    const decision = resolveModelReasoning(model, provider, { records: [] });
    expect(decision.support).toBe(support);
    expect(decision.mode).toBe('unknown');
    expect(decision).not.toHaveProperty('default');
    if (provider === 'anthropic') expect(decision.supportedEfforts).not.toContain('xhigh');
  });

  it('does not apply native maintained evidence to custom deployments or targets', () => {
    expect(resolveModelReasoning('gpt-5.4', 'openai', {
      records: [], scope: { deployment: 'custom' },
    }).support).toBe('absent');
    const pin = resolveModelReasoning('gpt-5.4', 'openai', { records: [] });
    expect(getRequestReasoning('gpt-5.4', 'openai', {}, { awfReasoning: pin }, {
      targetHost: 'custom.example',
    }).support).toBe('absent');
    expect(getRequestReasoning('gpt-5.4', 'openai', {}, {}, {
      targetHost: 'custom.example',
    }).support).toBe('absent');
    expect(getRequestReasoning('gpt-5.4', 'openai', {}, {}, {
      targetHost: 'api.openai.com', targetScheme: 'http',
    }).support).toBe('absent');
  });

  it('does not reject direct efforts omitted from maintained native routing lists', () => {
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8']) {
      const decision = getRequestReasoning(model, 'anthropic', { anthropic: [] }, {}, {
        targetHost: 'api.anthropic.com',
      });
      expect(decision.support).toBe('supported');
      expect(decision.supportedEfforts).not.toContain('xhigh');
      expect(assessReasoningEffort(decision, 'xhigh', { automatic: true }).admitted).toBe(false);
      expect(assessReasoningEffort(decision, 'xhigh', {
        directMaintainedEfforts: ['xhigh'],
      }).admitted).toBe(true);
      expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
        model, output_config: { effort: 'xhigh' },
      })), 'anthropic', '/messages', { anthropic: [] }, {}, {
        targetHost: 'api.anthropic.com',
      })).not.toThrow();
    }
    expect(() => validateReasoningEffort(Buffer.from(JSON.stringify({
      model: 'claude-opus-4-6', output_config: { effort: 'xhigh' },
    })), 'anthropic', '/messages', { anthropic: [] }, {}, {
      targetHost: 'api.anthropic.com',
    })).toThrow(expect.objectContaining({ code: 'unsupported_reasoning_effort' }));
  });

  it('scopes custom runtime evidence to its backend and limits Copilot omission to native catalogs', () => {
    expect(getReasoningScope('gemini', 'generativelanguage.googleapis.com', 'https'))
      .toEqual({ provider: 'gemini', channel: 'native-api' });
    expect(getReasoningScope('openai', 'api.openai.com:443', 'https'))
      .toEqual({ provider: 'openai', channel: 'native-api' });
    expect(getReasoningScope('gemini', 'custom.example', 'https')).toEqual({
      provider: 'gemini', channel: 'native-api', deployment: 'https://custom.example',
    });
    const scope = getReasoningScope('copilot', 'byok.example', 'https');
    expect(scope).toEqual({
      provider: 'copilot', channel: 'copilot-api', deployment: 'https://byok.example',
    });
    const decision = getRequestReasoning('byok-model', 'copilot', { copilot: [{
      id: 'byok-model', scope, capabilities: { supports: { streaming: true } },
    }] }, {}, { targetHost: 'byok.example', targetScheme: 'https' });
    expect(decision.support).toBe('unknown');

    const native = getRequestReasoning('native-model', 'copilot', { copilot: [{
      id: 'native-model', capabilities: { supports: { streaming: true } },
    }] }, {}, { targetHost: 'api.githubcopilot.com', targetScheme: 'https' });
    expect(native.support).toBe('unsupported');
  });

  it('pins direct decisions and candidate pools while refresh affects subsequent requests', () => {
    replaceRuntimeModels('copilot', [{ id: 'exact-test', supportedReasoningEfforts: ['low'] }]);
    const capture = captureRuntimePricing();
    const req = {};
    const pinned = getRequestReasoning('exact-test', 'copilot', capture, req);
    const normalized = normalizeModel('exact-test', capture.copilot[0], 'copilot');
    replaceRuntimeModels('copilot', [{ id: 'exact-test', supportedReasoningEfforts: ['max'] }]);
    capture.copilot[0].supportedReasoningEfforts.push('none');
    expect(getRequestReasoning('exact-test', 'copilot', capture, req)).toBe(pinned);
    expect(getModelReasoning(normalized, 'copilot')).toEqual(pinned);
    expect(getRequestReasoning('exact-test', 'copilot').supportedEfforts).toEqual(['max']);
    expect(() => validateReasoningEffort(body('exact-test', 'low'), 'copilot', '/chat/completions',
      undefined, { awfReasoning: pinned })).not.toThrow();
    expect(() => validateReasoningEffort(body('other', 'low'), 'copilot', '/chat/completions',
      { copilot: [{ id: 'other', supportedReasoningEfforts: [] }] }, { awfReasoning: pinned })).toThrow();
  });

  it('does not bypass existing policy or eligibility when reasoning is supported', () => {
    const model = normalizeModel('exact-test', {
      supportedReasoningEfforts: ['max'], supportedEndpoints: ['/responses'],
    }, 'copilot');
    const catalogue = { provider: 'copilot', configured: true, discovery: 'complete', models: [model] };
    expect(() => buildRoutingCandidates({ catalogue, policy: { disallowedModels: ['*'] } }))
      .toThrow(expect.objectContaining({ code: 'model_policy_violation' }));
    const eligibilityRequest = { awfEligibility: { evaluate: () => ({ admitted: false }) } };
    expect(() => buildRoutingCandidates({ catalogue, eligibilityRequest }))
      .toThrow(expect.objectContaining({ code: 'no_route' }));
  });
});
