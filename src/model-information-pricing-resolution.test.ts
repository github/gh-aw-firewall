import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { identity } from '../shared/model-information/identity';
import {
  resolvePricingCandidate, comparePricingResults, PricingCapture, PricingFact,
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
  const selected = resolvePricingCandidate(capture({ operator: fact('operator') }));
  expect(selected).toMatchObject({
    identity: identity('copilot', 'fixture'), scope,
    result: { source: 'operator', pricing: prices, tier: 'default' },
    componentSources: { cacheWrite: { source: 'operator', tier: 'default' } },
  });
  expect(() => resolvePricingCandidate(capture({ operator: null })))
    .toThrow('pricing_shadow_incomplete_capture');
});

it.each([199999, 200000, 200001])('independently selects strict long-context boundary %s', tokens => {
  const result = resolvePricingCandidate(capture({
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
  const result = resolvePricingCandidate(input);
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
  const result = resolvePricingCandidate(capture({
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
  const selected = resolvePricingCandidate(input);
  expect(selected.result).toMatchObject({
    source: 'central_feed', pricing: { input: 2, output: 0, cachedInput: 0, cacheWrite: null },
    pricingCatalogVersion: 'r1', observedAt: provenance.at,
  });
  expect(selected.componentSources.input).toMatchObject({
    observedAt: componentEvidence.at, pricingCatalogVersion: 'r1',
  });
  expect(selected.componentSources.output.observedAt).toBe(provenance.at);
  expect(resolvePricingCandidate({ ...input, scope: { ...scope, deployment: 'different' } }).result).toBeNull();
  record.tariffs[0].components.input.provenance = { at: '2026-10-01T00:00:00Z' };
  expect(resolvePricingCandidate(input).result).toBeNull();
});

it('preserves missing, explicit null, zero, reasoning and provenance differences', () => {
  const base = { source: 'provider' as const, tier: 'default', pricing: prices };
  expect(comparePricingResults(base, { ...base, pricing: { ...prices, cacheWrite: 0 } }))
    .toEqual(['components.cacheWrite']);
  const missing = { input: prices.input, output: prices.output, cachedInput: prices.cachedInput };
  expect(comparePricingResults(base, { ...base, pricing: missing }))
    .toEqual(['components.cacheWrite']);
  expect(comparePricingResults(base, { ...base, observedAt: 'changed',
    pricing: { ...prices, reasoning: 0 } })).toEqual(['observedAt', 'components.reasoning']);
  expect(comparePricingResults(null, base)).toEqual(['availability']);
  expect(comparePricingResults(null, null)).toEqual([]);
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
