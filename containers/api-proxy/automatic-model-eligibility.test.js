'use strict';

const { isAutomaticModelEligible } = require('./automatic-model-eligibility');
const { resolveModel, filterResolvableAliases, selectMiddlePowerFallback } = require('./model-resolver');
const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');
const { buildRoutingModelMetadata } = require('./management');
const { reflectScopedAuto } = require('./scoped-auto-model');
const { rewriteCopilotAutoResponsesModelInBody } = require('./model-body-rewriter');

afterEach(clearRuntimeModels);

describe('provider-metadata automatic selection eligibility', () => {
  test.each([
    undefined, {}, { supportedEndpoints: null },
    ...['/chat/completions', '/v1/chat/completions', 'chat/completions', 'chat_completions',
      '/responses', '/v1/responses', 'responses', '/messages', '/v1/messages', 'messages']
      .map(endpoint => ({ supportedEndpoints: ['/v1/decisions', endpoint] })),
  ])('keeps missing metadata and agent endpoints eligible: %p', record => {
    expect(isAutomaticModelEligible(record)).toBe(true);
  });

  test.each([
    { modelPickerEnabled: false },
    { modelPickerEnabled: false, supportedEndpoints: ['/responses'] },
    { supportedEndpoints: [] },
    { supportedEndpoints: ['/v1/decisions'] },
    { supportedEndpoints: ['decisions', '/embeddings', null, 42, 'ws:/responses'] },
  ])('excludes provider-declared non-agent models: %p', record => {
    expect(isAutomaticModelEligible(record)).toBe(false);
  });

  test('applies exclusions to metadata exposed through every backend', () => {
    for (const provider of ['openai', 'anthropic', 'google']) {
      replaceRuntimeModels(provider, [{ id: 'excluded', modelPickerEnabled: false }]);
      expect(selectMiddlePowerFallback('unknown', { [provider]: ['excluded'] }, provider, 'missing')).toBeNull();
    }
  });
});

describe('automatic resolver choices', () => {
  const records = [
    { id: 'gpt-6-luna-decisions', supportedEndpoints: ['/v1/decisions'], modelPickerEnabled: false },
    { id: 'gpt-5.6-luna-utility', supportedEndpoints: ['/v1/decisions'] },
    { id: 'gpt-5.8', modelPickerEnabled: false },
    { id: 'gpt-5.5', supportedEndpoints: ['/responses'] },
    { id: 'gpt-5.4', modelPickerEnabled: false },
    { id: 'gpt-5.3' },
  ];
  const models = { copilot: records.map(record => record.id) };
  const aliases = {
    large: ['copilot/gpt-*'],
    nested: ['large'],
    excluded: ['copilot/gpt-6*'],
    evals: ['copilot/gpt-6-luna-decisions'],
    mixed: ['copilot/gpt-6*', 'copilot/gpt-6-luna-decisions'],
  };

  beforeEach(() => replaceRuntimeModels('copilot', records));

  test.each(['large', 'nested'])('wildcard alias %s excludes utility and picker-disabled models', alias => {
    expect(resolveModel(alias, aliases, models, 'copilot')).toMatchObject({
      resolvedModel: 'gpt-5.5', candidates: alias === 'large' ? ['gpt-5.5', 'gpt-5.3'] : ['gpt-5.5'],
    });
  });

  test.each(['gpt-6-luna-decisions', 'evals', 'mixed'])('preserves explicit choice %s', model => {
    expect(resolveModel(model, aliases, models, 'copilot').resolvedModel).toBe('gpt-6-luna-decisions');
  });

  test('omits aliases whose only wildcard matches are excluded, but keeps literal aliases', () => {
    expect(resolveModel('excluded', aliases, models, 'copilot')).toBeNull();
    expect(filterResolvableAliases(aliases, models, ['copilot'])).toEqual({
      large: aliases.large, nested: aliases.nested, evals: aliases.evals, mixed: aliases.mixed,
    });
  });

  test('family-version replacement skips the newest excluded model', () => {
    expect(resolveModel('gpt-5.9', {}, models, 'copilot').resolvedModel).toBe('gpt-5.5');
    expect(resolveModel('gpt-5.4', {}, models, 'copilot').resolvedModel).toBe('gpt-5.4');
  });

  test('middle-power fallback uses only eligible candidates, including alias synthesis', () => {
    for (const result of [
      selectMiddlePowerFallback('unknown', models, 'copilot', 'missing', { enabled: true }),
      resolveModel('unknown', {}, models, 'copilot'),
      resolveModel('missing', { missing: ['copilot/not-found*'] }, models, 'copilot'),
    ]) {
      expect(result.fallback.candidates.map(candidate => candidate.model).sort()).toEqual(['gpt-5.3', 'gpt-5.5']);
    }
  });

  test('uses the request snapshot rather than a later global catalogue', () => {
    const req = { awfRuntimePricing: { copilot: records.map(record =>
      record.id === 'gpt-5.5' ? { ...record, modelPickerEnabled: false } : record) } };
    const result = resolveModel('large', aliases, models, 'copilot', [], undefined, null,
      true, { blocked: false }, req);
    expect(result.resolvedModel).toBe('gpt-5.3');
  });

  test('returns no automatic replacement when all available models are excluded', () => {
    const excludedModels = { copilot: models.copilot.slice(0, 2) };
    expect(resolveModel('unknown', {}, excludedModels, 'copilot')).toBeNull();
    expect(selectMiddlePowerFallback('unknown', excludedModels, 'copilot', 'missing')).toBeNull();
  });

  test('retains existing behavior when metadata is missing', () => {
    clearRuntimeModels();
    expect(resolveModel('large', aliases, models, 'copilot').resolvedModel).toBe('gpt-6-luna-decisions');
  });
});

test('reflection publishes the same decision without removing explicit choices', () => {
  const records = [
    { id: 'gpt-6-decisions', supportedEndpoints: ['/v1/decisions'] },
    { id: 'gpt-5', supportedEndpoints: ['/responses'], modelPickerEnabled: false },
    { id: 'unknown' },
    { id: 'chat', supportedEndpoints: ['/chat/completions'] },
  ];
  expect(buildRoutingModelMetadata('copilot', records.map(record => record.id), records)
    .map(({ model_id, automatic_selection_eligible }) => ({ model_id, automatic_selection_eligible })))
    .toEqual(records.map(record => ({
      model_id: record.id,
      automatic_selection_eligible: isAutomaticModelEligible(record),
    })));
});

test('both auto pickers share exclusions while retaining their endpoint and Codex requirements', () => {
  const records = [
    { id: 'gpt-9-codex', supportedEndpoints: ['/responses'], modelPickerEnabled: false },
    { id: 'gpt-8-codex', supportedEndpoints: ['/decisions'] },
    { id: 'gpt-7-codex', supportedEndpoints: ['/responses'] },
  ];
  const ids = records.map(record => record.id);
  expect(reflectScopedAuto('copilot', ids, records).candidates.openai.responses).toEqual(['gpt-7-codex']);
  expect(rewriteCopilotAutoResponsesModelInBody(Buffer.from('{"model":"auto"}'), ids, records).candidates)
    .toEqual(['gpt-7-codex']);
});

test('alias resolution uses refreshed provider metadata after an excluded-only first attempt', async () => {
  const savedAliases = process.env.AWF_MODEL_ALIASES;
  let records = [{ id: 'gpt-5.4', supportedEndpoints: ['/responses'], modelPickerEnabled: false }];
  const models = { copilot: ['gpt-5.4'] };
  const refresh = jest.fn(async () => {
    records = [
      { id: 'gpt-6-luna-decisions', supportedEndpoints: ['/v1/decisions'] },
      { id: 'gpt-5.5', supportedEndpoints: ['/responses'] },
    ];
    models.copilot = records.map(record => record.id);
  });
  let transform;
  try {
    process.env.AWF_MODEL_ALIASES = '{"models":{"large":["copilot/gpt-*"]}}';
    jest.isolateModules(() => {
      transform = require('./model-config').makeModelBodyTransform(
        'copilot', models, refresh, null, () => records,
      );
    });
    const req = {
      method: 'POST', url: '/responses',
      awfRuntimePricing: { copilot: records.slice() },
    };
    const result = await transform(Buffer.from('{"model":"large"}'), req);
    expect(JSON.parse(result).model).toBe('gpt-5.5');
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    if (savedAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
    else process.env.AWF_MODEL_ALIASES = savedAliases;
  }
});
