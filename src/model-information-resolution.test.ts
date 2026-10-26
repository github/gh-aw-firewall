import { resolveIdentity, stripRedundantProviderPrefix } from '../shared/model-information/resolution';
import { identity, ModelIdentity } from '../shared/model-information/identity';

const scope = { provider: 'openai', channel: 'native-api' };
const record = (rawId: string, extra: Partial<ModelIdentity> = {}) => ({
  identity: { ...identity('openai', rawId), ...extra },
});
const alias = (id: string, match = 'exact', aliasScope = scope) => ({ id, match, scope: aliasScope });
const rule = (family = 'gpt-5', extra = {}) => ({
  provider: 'openai', family, scope, field: 'reasoning', excludes: [], ...extra,
});

describe('shared identity resolution', () => {
  it('returns canonical identity, raw wire ID and separately preserved parameters', () => {
    const model = record('gpt-5.5');
    expect(resolveIdentity('OPENAI/gpt-5.5?effort=high?trace=1', scope, { models: [model] }))
      .toEqual({
        requestedModel: 'OPENAI/gpt-5.5?effort=high?trace=1', identity: model.identity,
        wireId: 'gpt-5.5', matchKind: 'exact', parameterSuffix: '?effort=high?trace=1',
        model: 'gpt-5.5?effort=high?trace=1',
      });
  });

  it('strips only the current provider prefix and preserves arbitrary slash deployment IDs', () => {
    expect(stripRedundantProviderPrefix('OpenAI/gpt-5', 'openai')).toBe('gpt-5');
    expect(stripRedundantProviderPrefix('OpenAI/', 'openai')).toBe('OpenAI/');
    expect(stripRedundantProviderPrefix('anthropic/gpt-5', 'openai')).toBe('anthropic/gpt-5');
    for (const requested of ['anthropic/gpt-5', 'deployments/team/prod', 'openai/deployments/prod']) {
      const rawId = requested.replace(/^openai\//, '');
      expect(resolveIdentity(requested, scope, { models: [record('gpt-5')] })).toEqual({
        requestedModel: requested, identity: identity('openai', rawId), wireId: rawId,
        matchKind: 'unmatched', parameterSuffix: '', model: rawId,
      });
    }
    expect(resolveIdentity('openai/gpt-5', scope, { models: [record('gpt-5')] },
      { providerPrefix: false }).matchKind).toBe('unmatched');
  });

  it.each([
    ['GPT-5.5', { caseInsensitive: true }],
    ['gpt_5_5', { separators: true }],
    ['gpt-5.5-2026-01-01', { stripDate: true }],
    ['gpt-5.5-20260101', { stripDate: true }],
    ['gpt-5.5-alpha-20260101', { stripDate: true }],
  ])('normalizes %s only with explicit policy', (requested, policy) => {
    const view = { models: [record('gpt-5.5')] };
    expect(resolveIdentity(requested, scope, view).matchKind).toBe('unmatched');
    expect(resolveIdentity(requested, scope, view, policy))
      .toMatchObject({ wireId: 'gpt-5.5', matchKind: 'exact' });
  });

  it('prefers raw exact IDs over normalized exacts and aliases, independent of record order', () => {
    const models = [
      record('gpt-5-5', { aliases: [alias('gpt-5.5')] }),
      record('gpt-5.5'),
      record('gpt-5.5-20260101'),
    ];
    for (const ordered of [models, [...models].reverse()]) {
      for (const requested of ['gpt-5.5', 'gpt-5.5-20260101']) {
        expect(resolveIdentity(requested, scope, { models: ordered },
          { separators: true, stripDate: true }).wireId).toBe(requested);
      }
    }
  });

  it('rejects ambiguous normalized exacts with actionable request error metadata', () => {
    expect(() => resolveIdentity('gpt_5_5', scope, {
      models: [record('gpt-5.5'), record('gpt-5-5')],
    }, { separators: true })).toThrow(expect.objectContaining({
      code: 'ambiguous_model_identity', statusCode: 400,
      message: expect.stringContaining('Use an exact model ID'),
    }));
  });

  it('enforces provider, channel, deployment and explicit alias matching policy', () => {
    const view = { models: [record('canonical', {
      aliases: [alias('named'), alias('UPPER', 'case-insensitive'),
        alias('with.dots', 'separators'),
        alias('private', 'exact', { ...scope, deployment: 'prod' } as typeof scope)],
    }), { identity: identity('anthropic', 'named') }] };
    for (const requested of ['named', 'upper', 'with_dots']) {
      expect(resolveIdentity(requested, scope, view)).toMatchObject({
        wireId: 'canonical', matchKind: 'alias',
      });
    }
    expect(resolveIdentity('NAMED', scope, view, { caseInsensitive: true }).matchKind).toBe('unmatched');
    expect(resolveIdentity('named', { ...scope, channel: 'copilot-api' }, view).matchKind).toBe('unmatched');
    expect(resolveIdentity('private', scope, view).matchKind).toBe('unmatched');
    expect(resolveIdentity('private', { ...scope, deployment: 'prod' }, view).matchKind).toBe('alias');
    expect(resolveIdentity('named', { provider: 'anthropic', channel: 'native-api' }, view).identity?.provider)
      .toBe('anthropic');
  });

  it('rejects applicable ambiguous aliases but ignores non-applicable alias scopes', () => {
    const first = record('first', { aliases: [alias('shared')] });
    const second = record('second', { aliases: [alias('shared')] });
    expect(() => resolveIdentity('shared', scope, { models: [first, second] }))
      .toThrow(expect.objectContaining({ code: 'ambiguous_model_identity', statusCode: 400 }));
    second.identity.aliases = [alias('shared', 'exact', { ...scope, channel: 'copilot-api' })];
    expect(resolveIdentity('shared', scope, { models: [first, second] }).wireId).toBe('first');
  });

  it('annotates family matches without renaming and honors exclusions, exceptions and scope', () => {
    const view = {
      models: [record('gpt-5-special', { family: 'special' })],
      rules: [rule('gpt-5', { excludes: ['openai/gpt-5-excluded'] })],
    };
    expect(resolveIdentity('gpt-5-future?x=1', scope, view)).toMatchObject({
      identity: identity('openai', 'gpt-5-future'), wireId: 'gpt-5-future',
      model: 'gpt-5-future?x=1', family: 'gpt-5', matchKind: 'family',
    });
    expect(resolveIdentity('gpt-5-excluded', scope, view).family).toBeUndefined();
    expect(resolveIdentity('gpt-5-special', scope, view).family).toBe('special');
    expect(resolveIdentity('gpt-5-future', { ...scope, deployment: 'prod' }, view).family).toBeUndefined();
    expect(resolveIdentity('gpt-5-future', { ...scope, channel: 'copilot-api' }, view).family).toBeUndefined();
  });

  it('annotates one family across distinct fields and identical duplicate facts', () => {
    const view = { models: [record('gpt-5-mini', { family: 'gpt-5' })],
      rules: [rule('gpt-5', { value: { enabled: true, mode: 'optional' } }),
        rule('gpt-5', { field: 'limits', value: { tokens: 1000 } }),
        rule('gpt-5', { value: { mode: 'optional', enabled: true } })] };
    for (const requested of ['gpt-5-mini', 'gpt-5-future']) {
      expect(resolveIdentity(requested, scope, view)).toMatchObject({
        wireId: requested, family: 'gpt-5',
      });
      expect(resolveIdentity(requested, scope, { ...view, rules: [...view.rules].reverse() }))
        .toEqual(resolveIdentity(requested, scope, view));
    }
  });

  it('rejects overlapping distinct families and conflicting equal-specificity facts', () => {
    expect(() => resolveIdentity('gpt-5-future', scope, {
      models: [], rules: [rule(), rule('gpt')],
    })).toThrow(expect.objectContaining({ code: 'ambiguous_model_identity', statusCode: 400 }));
    const view = { models: [record('gpt-5-mini', { family: 'gpt-5' })], rules: [
      rule('gpt-5', { value: { enabled: true } }),
      rule('GPT_5', { value: { enabled: false } }),
    ] };
    for (const requested of ['gpt-5-mini', 'gpt-5-future']) {
      expect(() => resolveIdentity(requested, scope, view))
        .toThrow(expect.objectContaining({ code: 'ambiguous_model_identity', statusCode: 400 }));
    }
    expect(() => resolveIdentity('gpt-5-future', scope, { models: [], rules: [
      rule('gpt-5', { value: { enabled: true } }),
      rule('GPT_5', { value: { enabled: true } }),
    ] })).not.toThrow();
  });

  it.each(['', '/bad', 'bad//id', 'bad/../id', 'bad#fragment', '?effort=high', 'openai/', null, 123])(
    'keeps malformed request %s opaque instead of throwing', requested => {
      expect(resolveIdentity(requested as string, scope, { models: [] })).toMatchObject({
        requestedModel: requested, identity: null, wireId: requested,
        model: requested, matchKind: 'unmatched',
      });
    },
  );
});
