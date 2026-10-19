import * as fixtures from '../shared/model-information/fixtures.v1.json';
import { validate, validateRecords } from '../shared/model-information/contracts';
import { identity, matchModel, matchFamilyRule, normalizeId } from '../shared/model-information/identity';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const provenance = fixtures.model.provenance;
const setCentralAuthorities = (value: any): void => {
  if (Array.isArray(value)) value.forEach(setCentralAuthorities);
  else if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'authority')) value.authority = 'central_feed';
    Object.values(value).forEach(setCentralAuthorities);
  }
};
const centralFeedRecord = (): any => {
  const model: any = copy(fixtures.model);
  for (const field of ['availability', 'limits', 'modalities', 'reasoning', 'protocols', 'translations']) {
    delete model[field];
  }
  delete model.identity.aliases;
  delete model.identity.family;
  model.lifecycle = { status: 'active' };
  setCentralAuthorities(model);
  return model;
};

describe('versioned model information contracts', () => {
  it.each(['model', 'overlay', 'importedSnapshot', 'centralFeed', 'resolvedExport'] as const)(
    'accepts %s and rejects unknown fields and versions', kind => {
      expect(validate(kind, fixtures[kind])).toEqual([]);
      expect(validate(kind, { ...fixtures[kind], unexpected: true })).not.toEqual([]);
      expect(validate(kind, { ...fixtures[kind], schemaVersion: 2 })).not.toEqual([]);
    },
  );

  it('retains future raw efforts, directed translator revisions and four capability states', () => {
    const model: any = copy(fixtures.model);
    expect(validate('model', model)).toEqual([]);
    expect(model.reasoning.rawEfforts).toContain('future-effort');
    expect(model.translations[0]).toMatchObject({ from: 'responses', to: 'chat-completions', revision: 'translator-1' });
    for (const state of ['supported', 'unsupported', 'unknown', 'conditional']) {
      const fact = copy(model.availability[0].fact);
      fact.state = state;
      if (state === 'conditional') fact.condition = 'enabled on deployment';
      else delete (fact as { condition?: string }).condition;
      model.availability[0].fact = fact;
      expect(validate('model', model)).toEqual([]);
    }
    delete (model.availability[0].fact as { condition?: string }).condition;
    model.availability[0].fact.state = 'conditional';
    expect(validate('model', model)).not.toEqual([]);
    model.availability[0].fact.condition = 'deployment enabled';
    model.reasoning.support = 'conditional';
    delete model.reasoning.condition;
    expect(validate('model', model)).not.toEqual([]);
    model.reasoning.condition = '';
    expect(validate('model', model)).not.toEqual([]);
    model.reasoning.condition = 'reasoning enabled';
    expect(validate('model', model)).toEqual([]);
    delete model.translations[0].condition;
    expect(validate('model', model)).not.toEqual([]);
    model.translations[0].condition = '';
    expect(validate('model', model)).not.toEqual([]);
    model.translations[0].condition = 'source protocol enabled';
    expect(validate('model', model)).toEqual([]);
  });

  it('enforces decimal precision, unavailable versus zero, promotion expiry and component provenance', () => {
    const model: any = copy(fixtures.model);
    const tariff = model.tariffs[0];
    expect(tariff.components.input.price).toBe('0.000000123456789');
    expect(tariff.components.output.price).toBe('0');
    expect(tariff.components.cacheWrite.price).toEqual({ unavailable: true });
    tariff.components.reasoning.price = '-1';
    expect(validate('model', model)).not.toEqual([]);
    tariff.components.reasoning.price = '1.25';
    delete (tariff as { effectiveUntil?: string }).effectiveUntil;
    expect(validate('model', model)).not.toEqual([]);
    tariff.effectiveUntil = '2026-11-01T00:00:00Z';
    delete (tariff.components.input as { provenance?: unknown }).provenance;
    expect(validate('model', model)).not.toEqual([]);
  });

  it('rejects invalid harness constraints, provenance and stale snapshot fields', () => {
    const model: any = copy(fixtures.model);
    model.harnesses[0].scheme = 'lexicographic';
    expect(validate('model', model)).not.toEqual([]);
    const snapshot: any = copy(fixtures.centralFeed);
    snapshot.provenance = { ...provenance, authority: 'central_feed', secret: 'not permitted' };
    expect(validate('centralFeed', snapshot)).not.toEqual([]);
    snapshot.provenance = { ...provenance, authority: 'central_feed', at: '2026-02-31T00:00:00Z' };
    expect(validate('centralFeed', snapshot)).not.toEqual([]);
    const imported: any = copy(fixtures.importedSnapshot);
    imported.accepted = 1;
    expect(validate('importedSnapshot', imported).join(' ')).toContain('accepted count');
  });

  it('rejects duplicate exact keys, ambiguous aliases, replacement gaps and family exceptions', () => {
    const model: any = copy(fixtures.model);
    expect(validateRecords([model])).toEqual([]);
    expect(validateRecords([model, copy(model)]).join(' ')).toContain('Duplicate exact key');
    const spelling: any = copy(model);
    spelling.identity = { ...identity('openai', 'GPT_5_5_PRO'), family: 'gpt-5.5' };
    expect(validateRecords([model, spelling]).join(' ')).toContain('Duplicate normalized exact key');
    const aliasCollision: any = copy(model);
    aliasCollision.identity = {
      ...identity('openai', 'another'), family: 'another',
      aliases: [{ id: 'gpt-5.5-pro', scope: { provider: 'openai', channel: 'native-api' }, match: 'exact' }],
    };
    expect(validateRecords([model, aliasCollision]).join(' ')).toContain('Alias collides with exact key');
    const other: any = copy(model);
    other.identity = { ...identity('openai', 'gpt-5.5-other'), lookupId: 'gpt-5-5-other', aliases: model.identity.aliases };
    expect(validateRecords([model, other]).join(' ')).toContain('Ambiguous scoped alias');
    other.identity.aliases = [];
    other.lifecycle.replacement = 'openai/missing';
    expect(validateRecords([model, other]).join(' ')).toContain('Unresolved replacement');
    other.lifecycle.replacement = model.identity.key;
    other.identity.family = 'gpt-5.5-other';
    const rule: any = {
      provider: 'openai', family: 'gpt-5.5', scope: { provider: 'openai', channel: 'native-api' },
      field: 'reasoning', value: { state: 'supported', provenance }, excludes: [], provenance,
    };
    expect(validateRecords([model, other], [rule]).join(' ')).toContain('Family captures declared exception');
    rule.excludes.push(model.identity.key, other.identity.key);
    expect(validateRecords([model, other], [rule, {
      ...rule, value: { state: 'unsupported', provenance },
    }]).join(' ')).toContain('Conflicting equal-specificity rules');
    expect(validateRecords([model, other], [rule, {
      ...rule, scope: { channel: 'native-api', provider: 'openai' },
      value: { provenance, state: 'unsupported' },
    }]).join(' ')).toContain('Conflicting equal-specificity rules');
    expect(validateRecords([model, other], [rule, {
      ...rule, scope: { channel: 'native-api', provider: 'openai' },
      value: { provenance, state: 'supported' },
    }]).join(' ')).not.toContain('Conflicting equal-specificity rules');
    expect(validateRecords([model], [{
      ...rule, scope: { provider: 'copilot', channel: 'native-api' },
    }]).join(' ')).toContain('Rule provider/scope mismatch');
    rule.excludes = [];
    expect(validateRecords([model], [rule])).toEqual([]);
    expect(matchFamilyRule(rule, 'gpt-5.5-pro', rule.scope, [model])).toMatchObject({ kind: 'family' });
    const normalizedException: any = copy(other);
    normalizedException.identity = {
      ...identity('openai', 'gpt-5.5-cyber'), family: 'gpt-5.5-cyber',
    };
    normalizedException.lifecycle.replacement = null;
    rule.excludes = ['OPENAI/GPT_5_5_CYBER'];
    expect(validateRecords([model, normalizedException], [rule]).join(' '))
      .not.toContain(`Family captures declared exception: ${normalizedException.identity.key}`);
    expect(matchFamilyRule(rule, 'GPT_5_5_CYBER', rule.scope, [normalizedException])).toBeNull();
    expect(validateRecords([null] as any).join(' ')).toContain('must be object');
    const invalidIdentity: any = copy(model);
    invalidIdentity.identity = { ...identity('openai', 'safe'), rawId: '../model' };
    expect(() => validateRecords([invalidIdentity])).not.toThrow();
  });

  it('rejects alias overlaps across mixed normalization policies', () => {
    const first: any = copy(fixtures.model);
    first.identity = {
      ...identity('openai', 'first'),
      aliases: [{ id: 'Foo_Bar', scope: { provider: 'openai', channel: 'native-api' }, match: 'separators' }],
    };
    const second: any = copy(fixtures.model);
    second.identity = {
      ...identity('openai', 'second'),
      aliases: [{ id: 'foo-bar', scope: { provider: 'openai', channel: 'native-api' }, match: 'case-insensitive' }],
    };
    expect(validateRecords([first, second]).join(' ')).toContain('Ambiguous scoped alias');
  });

  it('limits overlay records and rules to their declared provider, channel, and deployment scope', () => {
    const overlay: any = copy(fixtures.overlay);
    overlay.models = [copy(fixtures.model)];
    expect(validate('overlay', overlay)).toEqual([]);
    overlay.models[0].identity.provider = 'copilot';
    expect(validate('overlay', overlay).join(' ')).toContain('Overlay model provider is outside scope');

    const deploymentScoped: any = copy(fixtures.overlay);
    deploymentScoped.scope.deployment = 'production';
    deploymentScoped.models = [copy(fixtures.model)];
    expect(validate('overlay', deploymentScoped).join(' ')).toContain('Overlay scope does not contain model fact');
    for (const entry of deploymentScoped.models[0].availability) entry.scope.deployment = 'production';
    for (const entry of deploymentScoped.models[0].harnesses) entry.scope.deployment = 'production';
    for (const entry of deploymentScoped.models[0].tariffs) entry.scope.deployment = 'production';
    for (const entry of deploymentScoped.models[0].identity.aliases) entry.scope.deployment = 'production';
    expect(validate('overlay', deploymentScoped)).toEqual([]);

    const broadOverlay: any = copy(fixtures.overlay);
    broadOverlay.models = [copy(fixtures.model)];
    broadOverlay.models[0].tariffs[0].scope.deployment = 'production';
    expect(validate('overlay', broadOverlay)).toEqual([]);
    broadOverlay.rules = [{
      provider: 'openai', family: 'gpt-5.5',
      scope: { provider: 'openai', channel: 'copilot-api' },
      field: 'reasoning', value: { state: 'supported', provenance },
      excludes: [], provenance,
    }];
    expect(validate('overlay', broadOverlay).join(' ')).toContain('Overlay scope does not contain rule');
  });

  it('restricts central feed records to central-feed pricing and harness facts', () => {
    const feedWithModel = (): any => {
      const feed: any = copy(fixtures.centralFeed);
      feed.models = [centralFeedRecord()];
      return feed;
    };
    expect(validate('centralFeed', feedWithModel())).toEqual([]);

    const cases: Array<[string, (model: any) => void]> = [
      ['availability', model => { model.availability = []; }],
      ['lifecycle', model => { model.lifecycle.replacement = 'openai/replacement'; }],
      ['reasoning', model => { model.reasoning = copy(fixtures.model.reasoning); }],
      ['protocols', model => { model.protocols = copy(fixtures.model.protocols); }],
      ['operator authority', model => { model.provenance.authority = 'operator'; }],
      ['configured_catalog authority', model => { model.tariffs[0].provenance.authority = 'configured_catalog'; }],
      ['configured_catalog authority', model => {
        model.tariffs[0].components.input.provenance.authority = 'configured_catalog';
      }],
      ['operator authority', model => { model.harnesses[0].provenance.authority = 'operator'; }],
    ];
    for (const [message, mutate] of cases) {
      const feed = feedWithModel();
      mutate(feed.models[0]);
      expect(validate('centralFeed', feed).join(' ')).toContain(message);
    }
    const feed = feedWithModel();
    feed.provenance.authority = 'operator';
    expect(validate('centralFeed', feed).join(' ')).toContain('Central feed provenance');
  });
});

describe('provider-qualified identity (not a legacy migration)', () => {
  it('preserves raw IDs, provider distinctions and opt-in normalization policies', () => {
    expect(identity('copilot', 'GPT_5.5')).toEqual({
      key: 'copilot/GPT_5.5', provider: 'copilot', rawId: 'GPT_5.5', lookupId: 'gpt-5-5',
    });
    expect(identity('openai', 'GPT_5.5').key).not.toBe(identity('copilot', 'GPT_5.5').key);
    expect(identity('openai', 'gpt-5-codex/pro')).toMatchObject({
      key: 'openai/gpt-5-codex/pro', rawId: 'gpt-5-codex/pro',
    });
    expect(normalizeId('GPT_5.5-20261015', { caseInsensitive: true, separators: true, stripDate: true })).toBe('gpt-5-5');
    expect(normalizeId('GPT_5.5?effort=high', { caseInsensitive: true, separators: true })).toBe('gpt-5-5?effort=high');
    expect(() => identity('openai', 'model?query=1')).toThrow();
    expect(() => identity('openai', '../model')).toThrow();
  });

  it('matches exact before aliases; never enables family or provider-prefix rewriting implicitly', () => {
    const record = fixtures.model;
    const scope = { provider: 'openai', channel: 'native-api' };
    expect(matchModel(record, 'gpt-5.5-pro', scope)).toMatchObject({ kind: 'exact' });
    expect(matchModel(record, 'gpt_5_5_pro', scope)).toMatchObject({ kind: 'alias' });
    expect(matchModel(record, 'openai/gpt-5.5-pro', scope)).toBeNull();
    expect(matchModel(record, 'openai/gpt-5.5-pro', scope, { providerPrefix: true })).toMatchObject({ kind: 'exact' });
    expect(matchModel(record, 'gpt-5.5-pro-20261015', scope)).toBeNull();
    expect(matchModel(record, 'gpt-5.5-pro-20261015', scope, { stripDate: true })).toMatchObject({ kind: 'exact' });
    expect(matchModel(record, 'gpt-5.5-cyber', scope)).toBeNull();
    const rule = { provider: 'openai', family: 'gpt-5.5', scope, excludes: [] as string[] };
    expect(matchFamilyRule(rule, 'gpt-5.5-cyber', scope, [record])).toMatchObject({ kind: 'family' });
    const specialized: any = copy(record);
    specialized.identity = { ...identity('openai', 'gpt-5.5-cyber'), family: 'gpt-5.5-cyber' };
    expect(matchFamilyRule(rule, 'gpt-5.5-cyber', scope, [specialized])).toBeNull();
    rule.excludes.push('openai/gpt-5.5-cyber');
    expect(matchFamilyRule(rule, 'GPT_5_5_CYBER', scope)).toBeNull();
    expect(matchModel(record, 'gpt-5.5-pro', { ...scope, provider: 'copilot' })).toBeNull();
  });
});
