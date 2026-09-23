'use strict';

const { buildRoutingCandidates, normalizePolicyList } = require('./routing-candidates');
const { createRoutingCatalogue } = require('./routing-catalogue');
const { toRouteCandidates, validateRouteResponse } = require('./routing-contract');

function model(id, overrides = {}) {
  return { id, efforts: ['low', 'high'], protocols: ['responses', 'chat-completions'], ...overrides };
}

function catalogue(models) {
  return { provider: 'copilot', configured: true, discovery: 'complete', models };
}

function build(models, policy) {
  return buildRoutingCandidates({ catalogue: catalogue(models), policy });
}

describe('routing candidates', () => {
  it('builds frozen exact choices and native mappings', () => {
    const models = [
      model('gpt-test', { contextWindow: 128_000 }),
      model('claude-test', { efforts: [] }),
    ];
    const pool = build(models);
    expect(pool.choices).toEqual([
      { id: 'choice-0001', model: 'github-copilot/claude-test' },
      { id: 'choice-0002', model: 'github-copilot/gpt-test', effort: 'high' },
      { id: 'choice-0003', model: 'github-copilot/gpt-test', effort: 'low' },
    ]);
    expect(Object.getPrototypeOf(pool.byId)).toBeNull();
    expect(pool.byId['choice-0002']).toEqual({
      choice: pool.choices[1], provider: 'copilot', wireModel: 'gpt-test',
      effort: 'high', protocol: 'responses', contextWindow: 128_000,
    });
    expect(pool.byId['choice-0001']).toEqual({
      choice: pool.choices[0], provider: 'copilot', wireModel: 'claude-test', protocol: 'chat-completions',
    });
    expect(Object.isFrozen(pool)).toBe(true);
    expect(Object.isFrozen(pool.choices)).toBe(true);
    expect(Object.isFrozen(pool.byId)).toBe(true);
    for (const choice of pool.choices) {
      expect(Object.isFrozen(choice)).toBe(true);
      expect(Object.isFrozen(pool.byId[choice.id])).toBe(true);
      expect(pool.byId[choice.id].choice).toBe(choice);
    }
    expect(build([...models].reverse())).toEqual(pool);
    expect(validateRouteResponse({ ranked_choices: pool.choices }, pool.choices).ranked_choices).toBe(pool.choices);
    expect(toRouteCandidates(pool)[1].context_window).toBe(128_000);
  });

  it('includes every advertised effort without inventing a default', () => {
    const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const pool = build([model('gpt-test', { efforts })]);
    expect(pool.choices.map(choice => choice.effort)).toEqual([...efforts].sort());
    expect(build([model('gpt-test', { efforts: [...efforts].reverse() })])).toEqual(pool);
  });

  it('keeps omitted effort distinct from explicit none', () => {
    const pool = build([model('empty', { efforts: [] }), model('none', { efforts: ['none'] })]);
    expect(pool.choices[0]).not.toHaveProperty('effort');
    expect(pool.byId['choice-0001']).not.toHaveProperty('effort');
    expect(pool.byId['choice-0001'].protocol).toBe('chat-completions');
    expect(pool.choices[1].effort).toBe('none');
    expect(pool.byId['choice-0002'].protocol).toBe('responses');
  });

  it('derives the protocol from effort rather than preferring one endpoint', () => {
    const pool = build([
      model('both', { efforts: ['none'] }),
      model('chat', { efforts: [], protocols: ['chat-completions'] }),
      model('wrong-effort', { protocols: ['chat-completions'] }),
      model('wrong-empty', { efforts: [], protocols: ['responses'] }),
    ]);
    expect(pool.choices.map(choice => choice.model)).toEqual(['github-copilot/both', 'github-copilot/chat']);
    expect(Object.values(pool.byId).map(mapping => mapping.protocol)).toEqual(['responses', 'chat-completions']);
  });

  it.each(['*sonnet*', 'copilot/*sonnet*', 'github-copilot/*sonnet*', 'github/*sonnet*'])(
    'supports native and provider-qualified policy patterns with deny precedence: %s',
    pattern => {
      const pool = build([model('claude-sonnet-4.6'), model('claude-sonnet-4.5'), model('gpt-test')], {
        allowedModels: [` ${pattern} `], disallowedModels: ['github/*4.5'],
      });
      expect(pool.choices.map(choice => choice.model)).toEqual([
        'github-copilot/claude-sonnet-4.6', 'github-copilot/claude-sonnet-4.6',
      ]);
    },
  );

  it('deduplicates overlapping policy patterns, model identities, and efforts', () => {
    const pool = build([
      model('gpt-test', { efforts: ['low', 'low'] }), model('GPT-TEST'), model('gpt-test'),
    ], { allowedModels: ['*', 'copilot/*', 'github/*'] });
    expect(pool.choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/gpt-test', effort: 'low' }]);
    expect(pool.byId['choice-0001'].wireModel).toBe('gpt-test');
  });

  it('freezes one copied snapshot while a later run can see catalogue changes', async () => {
    const metadata = [{
      id: 'gpt-test', supportedReasoningEfforts: ['low'], supportedEndpoints: ['/responses'],
      capabilities: { limits: { max_context_window_tokens: 128_000 } },
    }];
    const source = createRoutingCatalogue({
      getCopilotAdapter: () => ({
        name: 'copilot', isEnabled: () => true, getRoutingProviderIdentity: () => 'github-copilot',
      }),
      getDiscoveredModels: () => ['gpt-test'],
      getRuntimeModels: () => metadata,
    });
    const snapshot = await source.getSnapshot();
    const pool = buildRoutingCandidates({ catalogue: snapshot });
    metadata[0].supportedReasoningEfforts.push('high');
    metadata[0].capabilities.limits.max_context_window_tokens = 256_000;
    expect(pool.choices).toHaveLength(1);
    expect(pool.byId['choice-0001'].contextWindow).toBe(128_000);
    expect(buildRoutingCandidates({ catalogue: snapshot })).toEqual(pool);
    const later = buildRoutingCandidates({ catalogue: await source.getSnapshot() });
    expect(later.choices).toHaveLength(2);
    expect(later.byId['choice-0001'].contextWindow).toBe(256_000);
    expect(() => { pool.byId['choice-0001'].wireModel = 'changed'; }).toThrow(TypeError);
  });

  it('fails closed when policy removes a nonempty authoritative catalogue', () => {
    expect(() => build([model('gpt-test')], { allowedModels: ['copilot/*'], disallowedModels: ['github/*'] }))
      .toThrow(expect.objectContaining({ code: 'model_policy_violation', retryable: false }));
  });

  it('does not let another provider qualification admit a Copilot model', () => {
    expect(() => build([model('gpt-test')], { allowedModels: ['openai/*'] }))
      .toThrow(expect.objectContaining({ code: 'model_policy_violation' }));
  });

  it.each(['efforts', 'protocols'])('excludes a model with unknown %s without losing alternatives', field => {
    const pool = build([model('unknown', { [field]: undefined }), model('known', { efforts: [] })]);
    expect(pool.choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/known' }]);
  });

  it('drops efforts outside the contract enum instead of failing the snapshot', () => {
    const pool = build([model('gpt-test', { efforts: ['future', 'low', 'LOW', null, 'low'] })]);
    expect(pool.choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/gpt-test', effort: 'low' }]);
  });

  it('excludes a model whose every advertised effort is outside the contract enum', () => {
    const unknown = model('unknown', { efforts: ['future'] });
    expect(build([unknown, model('known', { efforts: [] })]).choices)
      .toEqual([{ id: 'choice-0001', model: 'github-copilot/known' }]);
    expect(() => build([unknown])).toThrow(expect.objectContaining({ code: 'no_route' }));
  });

  it('returns no route when no permitted model advertises a usable protocol', () => {
    expect(() => build([
      model('unknown', { protocols: [] }),
      model('wrong', { efforts: [], protocols: ['responses'] }),
      model('missing', { efforts: undefined }),
    ])).toThrow(expect.objectContaining({ code: 'no_route', retryable: false }));
  });

  it.each([
    undefined,
    { ...catalogue([model('gpt-test')]), provider: 'openai' },
    { ...catalogue([model('gpt-test')]), configured: false },
    { ...catalogue([model('gpt-test')]), discovery: 'failed' },
    catalogue([]),
  ])('fails closed for unavailable provider or discovery: %j', snapshot => {
    expect(() => buildRoutingCandidates({ catalogue: snapshot }))
      .toThrow(expect.objectContaining({ code: 'provider_unavailable' }));
  });

  it.each([null, [], {}, { id: '' }, { id: 42 }])('rejects invalid catalogue records: %j', record => {
    expect(() => build([record])).toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
  });
});

describe('normalizePolicyList', () => {
  it.each([undefined, null, []])('treats an absent or empty policy as unrestricted: %j', value => {
    expect(normalizePolicyList(value, 'allowedModels')).toBeNull();
  });

  it('copies and trims raw policy patterns before filtering', () => {
    const raw = ['  copilot/gpt-*  '];
    expect(normalizePolicyList(raw, 'allowedModels')).toEqual(['copilot/gpt-*']);
    expect(raw).toEqual(['  copilot/gpt-*  ']);
    expect(build([model('gpt-test')], { allowedModels: [], disallowedModels: [] }).choices).toHaveLength(2);
  });

  it.each(['*', {}, [null], [3], [''], ['  '], ['${{ inputs.model }}']])('rejects invalid raw policies: %j', value => {
    for (const name of ['allowedModels', 'disallowedModels']) {
      expect(() => build([model('gpt-test')], { [name]: value }))
        .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
    }
  });
});
