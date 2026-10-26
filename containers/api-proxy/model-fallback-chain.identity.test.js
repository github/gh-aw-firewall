'use strict';

jest.mock('./model-information.naming.generated.json', () => ({
  models: [
    ['copilot', 'gpt-5-codex', 'old-codex'],
    ['copilot', 'canonical-model', 'friendly-model'],
    ['openai', 'canonical-model', 'friendly-model'],
  ].map(([provider, rawId, alias]) => ({
    identity: {
      key: `${provider}/${rawId}`, provider, rawId, lookupId: rawId,
      aliases: [{
        id: alias, match: 'exact',
        scope: { provider, channel: provider === 'copilot' ? 'copilot-api' : 'native-api' },
      }],
    },
  })),
  rules: [],
}), { virtual: true });

const { selectNextFallbackCandidate, resolveFallbackEntry, selectNextFallbackModel } = require('./model-fallback-chain');
const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { buildRoutingCandidates } = require('./routing-candidates');

test('canonical identities close alias policy bypasses in both directions', () => {
  for (const model of ['canonical-model', 'friendly-model', 'github/friendly-model?effort=high']) {
    expect(isModelPermittedByPolicy(model, ['*'], ['copilot/canonical-model'], 'copilot')).toBe(false);
    expect(isModelPermittedByPolicy(model, ['copilot/canonical-model'], null, 'copilot')).toBe(true);
    expect(isModelPermittedByPolicy(model, null, ['friendly-model'], 'copilot')).toBe(false);
    expect(isModelPermittedByPolicy(model, null, ['copilot/friendly-*'], 'copilot')).toBe(false);
    expect(isModelPermittedByPolicy(model, ['friendly-*'], null, 'copilot')).toBe(true);
  }
  expect(isModelPermittedByPolicy('friendly-model', null, ['copilot/canonical-model'], 'openai')).toBe(true);
  expect(isModelPermittedByPolicy('canonical_model', ['canonical-model'], null, 'copilot')).toBe(false);
  expect(isModelPermittedByPolicy('openai/canonical-model', ['openai/canonical-model'], null, 'copilot')).toBe(false);
});

test('retirement follows aliases without enabling separator or date normalization', () => {
  for (const model of ['old-codex', 'github/old-codex?reasoning=high', 'GPT-5-CODEX?effort=high']) {
    expect(getRetiredModelBlockState(model)).toEqual({ model, suggestion: 'gpt-5.3-codex' });
  }
  for (const model of ['gpt_5_codex', 'gpt-5-codex-20261001', 'openai/old-codex']) {
    expect(getRetiredModelBlockState(model)).toBeNull();
  }
});

test('explicit fallback resolves wire IDs with parameters and deduplicates canonical attempts', () => {
  expect(resolveFallbackEntry('openai/openai/canonical-model', 'copilot'))
    .toMatchObject({ provider: 'openai', model: 'openai/canonical-model' });
  expect(resolveFallbackEntry('copilot/copilot/canonical-model', 'copilot'))
    .toMatchObject({ provider: 'copilot', model: 'copilot/canonical-model' });
  expect(resolveFallbackEntry('openai/friendly-model?effort=high', 'copilot'))
    .toEqual({
      entry: 'openai/friendly-model?effort=high', provider: 'openai',
      model: 'canonical-model?effort=high', qualified: true,
    });
  expect(selectNextFallbackModel(
    ['friendly-model', 'next-model'], ['canonical-model'], 'copilot',
  )).toBe('next-model');
  expect(selectNextFallbackCandidate(
    ['friendly-model', 'openai/friendly-model'], ['canonical-model'], 'copilot',
  )).toMatchObject({ provider: 'openai', model: 'canonical-model' });
});

test('fallback uses real policy and retirement guards for each target provider', () => {
  const isPermitted = (model, provider) =>
    isModelPermittedByPolicy(model, null, ['copilot/canonical-model'], provider) &&
    (provider !== 'copilot' || !getRetiredModelBlockState(model));
  expect(selectNextFallbackCandidate(
    ['old-codex?effort=high', 'friendly-model', 'openai/friendly-model'], [], 'copilot', { isPermitted },
  )).toMatchObject({ provider: 'openai', model: 'canonical-model' });
  expect(selectNextFallbackCandidate(
    ['friendly-model'], [], 'copilot', { isPermitted },
  )).toBeNull();
});

test('routing candidates filter retired aliases while preserving public choice identifiers', () => {
  const pool = buildRoutingCandidates({
    catalogue: {
      provider: 'copilot', configured: true, discovery: 'complete',
      models: ['old-codex?effort=high', 'friendly-model'].map(id => ({
        id, efforts: [], protocols: ['chat-completions'],
      })),
    },
  });
  expect(pool.choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/friendly-model' }]);
  expect(pool.byId['choice-0001'].wireModel).toBe('friendly-model');
});

test('request policy guard rejects canonical deny rules through aliases and suffixes', () => {
  const previous = process.env.AWF_DISALLOWED_MODELS;
  process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['copilot/canonical-model']);
  jest.resetModules();
  try {
    const { getModelPolicyBlockState } = require('./guards/model-policy-guard');
    const model = 'github/friendly-model?reasoning=high';
    expect(getModelPolicyBlockState(model, 'copilot')).toEqual({ model, reason: 'disallowed' });
    expect(getModelPolicyBlockState('friendly-model', 'openai')).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.AWF_DISALLOWED_MODELS;
    else process.env.AWF_DISALLOWED_MODELS = previous;
  }
});
