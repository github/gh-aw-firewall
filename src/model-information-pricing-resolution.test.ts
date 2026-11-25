import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identity } from '../shared/model-information/identity';
import {
  resolvePricing, PricingCapture, PricingFact,
} from '../shared/model-information/pricing-resolution';

const prices = { input: 2, output: 4, cachedInput: 0, cacheWrite: null };
const fact = (source: PricingFact['source'], input = 2): PricingFact => ({
  source, default: { ...prices, input },
});
const scope = { provider: 'copilot', channel: 'copilot-api' };
const capture = (sources: PricingCapture['sources'], inputTokens = 0): PricingCapture => ({
  identity: identity('copilot', 'fixture'), scope,
  inputTokens, time: Date.parse('2026-11-01T12:00:00Z'), maxAge: 86400000, sources,
});
const absent = { operator: null, configured: null, runtime: null, central: null,
  curated: null, imported: null, selector: null, configuredDefault: null, sentinel: null };

it('short-circuits on reached facts without requiring or inventing lower observations', () => {
  const selected = resolvePricing(capture({ operator: fact('operator') }));
  expect(selected).toMatchObject({
    identity: identity('copilot', 'fixture'), scope,
    result: { source: 'operator', pricing: prices, tier: 'default' },
    componentSources: { cacheWrite: { source: 'operator', tier: 'default' } },
  });
  expect(() => resolvePricing(capture({ operator: null })))
    .toThrow('pricing_resolution_incomplete_sources');
});

it.each([199999, 200000, 200001])('independently selects strict long-context boundary %s', tokens => {
  const result = resolvePricing(capture({
    operator: { ...fact('operator'), threshold: 200000, longContext: { ...prices, input: 9 } },
  }, tokens)).result;
  expect(result?.tier).toBe(tokens > 200000 ? 'long_context' : 'default');
  expect(result?.pricing.input).toBe(tokens > 200000 ? 9 : 2);
});

it('assembles only missing provider components with same-tier provenance without mutating facts', () => {
  const input = capture({
    ...absent,
    runtime: {
      source: 'provider', default: { input: 1, output: 3, threshold: 10 },
      longContext: { input: 5, output: 8, cacheWrite: 0 }, threshold: 10,
      longMetadata: { observedAt: '2026-11-01T00:00:00Z' },
    },
    curated: {
      ...fact('curated'), threshold: 100, longContext: { ...prices, cachedInput: 7 },
    },
  }, 11);
  const before = structuredClone(input);
  const result = resolvePricing(input);
  expect(result).toMatchObject({
    result: { source: 'provider', tier: 'long_context',
      pricing: { input: 5, output: 8, cachedInput: 7, cacheWrite: 0 } },
    componentSources: {
      input: { source: 'provider', tier: 'long_context', observedAt: '2026-11-01T00:00:00Z' },
      cachedInput: { source: 'curated', tier: 'long_context' },
    },
  });
  expect(input).toEqual(before);
});

it('retains the legacy stale-complete-provider fallback quirk, not a freshness correction', () => {
  const result = resolvePricing(capture({
    ...absent, runtime: {
      ...fact('provider', 9), defaultMetadata: { observedAt: '2026-10-01T00:00:00Z' },
    },
    curated: fact('curated', 2),
  }));
  expect(result.result?.source).toBe('provider');
  expect(result.result?.pricing.input).toBe(9);
});

it('retains component-specific central evidence, scoped selection, units and revision', () => {
  const provenance = { at: '2026-11-01T00:00:00Z' };
  const componentEvidence = { at: '2026-11-01T01:00:00Z' };
  const record = {
    identity: identity('copilot', 'fixture'), provenance,
    tariffs: [{
      scope, tier: 'default', unit: 'USD_PER_TOKEN' as const, provenance,
      components: {
        input: { price: '0.000002', provenance: componentEvidence },
        output: { price: '0', provenance },
        cachedInput: { price: '0', provenance },
        cacheWrite: { price: { unavailable: true }, provenance },
      },
    }],
  };
  const input = capture({
    ...absent, central: { record, source: 'fixture-feed', revision: 'r1' },
  });
  const selected = resolvePricing(input);
  expect(selected.result).toMatchObject({
    source: 'central_feed', pricing: { input: 2, output: 0, cachedInput: 0, cacheWrite: null },
    pricingCatalogVersion: 'r1', observedAt: provenance.at,
  });
  expect(selected.componentSources.input).toMatchObject({
    observedAt: componentEvidence.at, pricingCatalogVersion: 'r1',
  });
  expect(selected.componentSources.input.unavailable).toBeUndefined();
  expect(selected.componentSources.output.observedAt).toBe(provenance.at);
  expect(selected.componentSources.cacheWrite).toMatchObject({
    source: 'central_feed', tier: 'default', observedAt: provenance.at, unavailable: true,
  });
  expect(resolvePricing({ ...input, scope: { ...scope, deployment: 'different' } }).result).toBeNull();
  record.tariffs[0].components.input.provenance = { at: '2026-10-01T00:00:00Z' };
  expect(resolvePricing(input).result).toBeNull();
});

it('preserves unavailable component provenance per tier and across partial-runtime merges', () => {
  const curatedFact: PricingFact = {
    source: 'curated',
    default: { input: 2, output: 10, cachedInput: 0.1, cacheWrite: null },
    defaultMetadata: { unavailableComponents: ['cacheWrite'] },
    longContext: { input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5 },
    threshold: 100,
    longMetadata: {},
  };
  const base = resolvePricing(capture({ ...absent, curated: curatedFact }, 50));
  expect(base.componentSources.cacheWrite.unavailable).toBe(true);
  expect(base.componentSources.input.unavailable).toBeUndefined();

  const long = resolvePricing(capture({ ...absent, curated: curatedFact }, 101));
  expect(long.componentSources.cacheWrite.unavailable).toBeUndefined();

  const merged = resolvePricing(capture({
    ...absent,
    runtime: { source: 'provider', default: { input: 2, output: 10, cachedInput: 0.1 } },
    curated: curatedFact,
  }, 50));
  expect(merged.componentSources.input).toMatchObject({ source: 'provider', tier: 'default' });
  expect(merged.componentSources.cacheWrite).toMatchObject({
    source: 'curated', tier: 'default', unavailable: true,
  });
});

it('clears central unavailable cacheWrite only for an exact tariff-scoped no-separate-charge match', () => {
  const provenance = { at: '2026-11-01T00:00:00Z' };
  const record = {
    identity: identity('copilot', 'fixture'), provenance,
    tariffs: [{
      scope, tier: 'default', unit: 'USD_PER_1M_TOKENS' as const, provenance,
      components: {
        input: { price: '1.5', provenance },
        output: { price: '7.5', provenance },
        cachedInput: { price: '0.075', provenance },
        cacheWrite: { price: { unavailable: true }, provenance },
      },
    }],
  };
  const matching = resolvePricing(capture({
    ...absent,
    central: {
      record, source: 'fixture-feed', revision: 'r1',
      noSeparateCacheWrite: [{ tier: 'default', pricing: { input: 1.5, cachedInput: 0.075, cacheWrite: null, output: 7.5 } }],
    },
  }));
  expect(matching.result?.pricing.cacheWrite).toBeNull();
  expect(matching.componentSources.cacheWrite.unavailable).toBeUndefined();

  const changedRate = resolvePricing(capture({
    ...absent,
    central: {
      record, source: 'fixture-feed', revision: 'r1',
      noSeparateCacheWrite: [{ tier: 'default', pricing: { input: 2, cachedInput: 0.075, cacheWrite: null, output: 7.5 } }],
    },
  }));
  expect(changedRate.componentSources.cacheWrite.unavailable).toBe(true);
});

it.each([null, 0])('preserves explicit cache-write %s and genuine zero reasoning prices', cacheWrite => {
  const result = resolvePricing(capture({
    operator: { ...fact('operator'), default: { ...prices, cacheWrite, reasoning: 0 } },
  })).result;
  expect(result?.pricing).toEqual({ ...prices, cacheWrite, reasoning: 0 });
});

it('missing runtime components remain unpriced rather than zero without a fallback', () => {
  const resolution = resolvePricing(capture({
    ...absent, runtime: { source: 'provider', default: { input: 1, output: 2 } },
  }));
  expect(resolution.result).toBeNull();
  expect(resolution.missingModelPricing).toBe(true);
});

it.each([NaN, Infinity, -1, undefined])('invalid selected prices %s fail explicitly, not as free usage', input => {
  expect(() => resolvePricing(capture({
    operator: { ...fact('operator'), default: { ...prices, input } },
  }))).toThrow('pricing_resolution_invalid_tariff');
});

it('reads each source only once and never reads a lower source after selection', () => {
  const operator = jest.fn(() => null);
  const configured = jest.fn(() => fact('shared_catalog', 9));
  const runtime = jest.fn(() => { throw new Error('must not initialize'); });
  expect(resolvePricing(capture({ operator, configured, runtime })).result?.pricing.input).toBe(9);
  expect(operator).toHaveBeenCalledTimes(1);
  expect(configured).toHaveBeenCalledTimes(1);
  expect(runtime).not.toHaveBeenCalled();
});

it('generates identical host, shared and container implementations and declarations', () => {
  for (const extension of ['js', 'd.ts']) {
    const shared = readFileSync(join(__dirname,
      `../shared/model-information/pricing-resolution.${extension}`), 'utf8');
    for (const folder of ['src/model-information-contract', 'containers/api-proxy/catalogue-contract']) {
      expect(readFileSync(join(__dirname, `../${folder}/pricing-resolution.${extension}`), 'utf8'))
        .toBe(shared);
    }
  }
});
