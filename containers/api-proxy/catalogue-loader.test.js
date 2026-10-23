'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const https = require('node:https');
const { createCatalogueLoader, getBytes } = require('./catalogue-loader');
const { buildSnapshot, validateSnapshot } = require('./catalogue-contract/publication.cjs');
const { json, digest, payload } = require('./catalogue-contract/publication-contract.cjs');
const { resolveCentralPricing } = require('./catalogue-pricing');
const { applyAiCreditsUsage, resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');
const { replaceRuntimeModels, clearRuntimeModels, captureRuntimePricing } = require('./runtime-model-catalog');
const { computeTokenBudgetUsage } = require('./token-budget-log');
const { resetModelPricingCatalogForTests } = require('./model-pricing-catalog');
const { resetProviderPricingOverlaysForTests } = require('./provider-pricing-overlays');
const baseline = require('../../shared/model-information/catalog.generated.json');

const NOW = Date.parse('2026-10-23T12:00:00Z');
const FIRST = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const DATA = 'd'.repeat(40);
const MAIN = 'f'.repeat(40);
const ROOT = 'https://api.github.com/repos/github/gh-aw-firewall';

function catalogue(price = '2') {
  const model = structuredClone(baseline.models.find(entry => entry.tariffs?.length));
  model.identity = { key: 'copilot/loader-test', provider: 'copilot', rawId: 'loader-test', lookupId: 'loader-test' };
  model.tariffs = [model.tariffs.find(tariff => tariff.tier === 'default')];
  model.tariffs[0].components.input.price = price;
  return { ...baseline, models: [model] };
}

function publication(price = '2', source = FIRST, sourceTime = '2026-10-22T00:00:00Z') {
  const catalog = catalogue(price);
  const bytes = buildSnapshot(catalog, source, sourceTime);
  const snapshot = JSON.parse(bytes);
  return { catalog, bytes, snapshot, pointer: {
    schemaVersion: 1, revision: snapshot.revision, sourceCommit: source,
    snapshot: `snapshots/v1/${snapshot.revision}.json`, sha256: digest(bytes),
  } };
}

function githubFixture(pub = publication()) {
  const get = jest.fn(async url => {
    const suffix = url.slice(ROOT.length);
    if (suffix === '/git/ref/heads/catalogue-data') {
      return Buffer.from(json({ ref: 'refs/heads/catalogue-data', object: { sha: DATA, type: 'commit' } }));
    }
    if (suffix === '/git/ref/heads/main') {
      return Buffer.from(json({ ref: 'refs/heads/main', object: { sha: MAIN, type: 'commit' } }));
    }
    if (suffix.startsWith('/compare/')) {
      const base = suffix.split('/compare/')[1].split('...')[0];
      if (suffix.includes(`${NEXT}...${FIRST}`)) return Buffer.from(json({ status: 'behind' }));
      return Buffer.from(json({ status: 'ahead', merge_base_commit: { sha: base } }));
    }
    if (suffix.startsWith('/commits?')) {
      return Buffer.from(json(pub.pointer.sourceCommit === FIRST
        ? [{ sha: FIRST }] : [{ sha: NEXT }, { sha: FIRST }]));
    }
    if (suffix.startsWith('/git/commits/')) {
      return Buffer.from(json({ sha: suffix.split('/').at(-1), committer: { date: '2026-10-22T00:00:00Z' } }));
    }
    if (suffix === `/contents/channels/v1/current.json?ref=${DATA}`) return Buffer.from(json(pub.pointer));
    if (suffix === `/contents/${pub.pointer.snapshot}?ref=${DATA}`) return Buffer.from(pub.bytes);
    if (suffix.startsWith('/contents/shared/model-information/catalog.generated.json?ref=')) {
      return Buffer.from(json(pub.catalog));
    }
    throw new Error(`Unexpected fixture URL ${url}`);
  });
  return get;
}

let directory;
let loaders;
function loader(options = {}, deps = {}) {
  const result = createCatalogueLoader({ cacheDirectory: path.join(directory, 'cache'), ...options },
    { now: () => NOW, report: jest.fn(), ...deps });
  loaders.push(result);
  return result;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-loader-test-'));
  loaders = [];
  resetAiCreditsGuardForTests();
  clearRuntimeModels();
});
afterEach(async () => {
  await Promise.all(loaders.map(item => item.stop()));
  fs.rmSync(directory, { recursive: true, force: true });
  clearRuntimeModels();
  jest.restoreAllMocks();
});

test('authenticates reviewed source, pins immutable reads and reaches actual accounting', async () => {
  const get = githubFixture();
  const instance = loader({}, { getBytes: get });
  await instance.start();
  expect(instance.reflect()).toMatchObject({ state: 'active', sourceCommit: FIRST });
  expect(get.mock.calls.every(([url]) => url.startsWith(ROOT))).toBe(true);
  expect(get.mock.calls.filter(([url]) => /channels|snapshots/.test(url))
    .every(([url]) => url.endsWith(`?ref=${DATA}`))).toBe(true);
  const result = computeTokenBudgetUsage({
    logRequest: jest.fn(), requestId: 'test', provider: 'copilot', catalogue: instance.capture(),
  }, { input_tokens: 1_000_000 }, 'loader-test');
  expect(result).toMatchObject({
    ai_credits_this_response: 200, ai_credits_pricing_source: 'central_feed',
    ai_credits_pricing_catalog_version: publication().snapshot.revision,
  });
});

test.each(['bytes', 'price', 'schema', 'pointer', 'publishedAt', 'effectiveFrom', 'observedAt', 'sourceCommit'])(
  'rejects tampered %s even with recomputed integrity hashes', async field => {
    const pub = publication();
    if (field === 'price') {
      const changed = publication('0');
      pub.bytes = changed.bytes;
      pub.pointer = changed.pointer;
    } else if (field === 'schema') {
      pub.bytes = pub.bytes.replace('"schemaVersion": 1', '"schemaVersion": 99');
    } else if (field === 'pointer') {
      pub.pointer.snapshot = 'https://attacker.invalid/prices';
    } else if (field === 'bytes') {
      pub.bytes += '\n';
    } else {
      const value = JSON.parse(pub.bytes);
      value[field] = field === 'sourceCommit' ? NEXT : '2026-10-23T00:00:00.000Z';
      pub.bytes = json(value);
    }
    pub.pointer.sha256 = digest(pub.bytes);
    const instance = loader({}, { getBytes: githubFixture(pub) });
    await instance.start();
    expect(instance.capture()).toBeNull();
    expect(instance.reflect().failure).toBeTruthy();
  },
);

test('custom/local snapshots must obey producer evidence and calendar semantics, not only digests', () => {
  for (const variant of ['empty', 'evidence', 'calendar']) {
    const value = publication().snapshot;
    if (variant === 'empty') value.models = [];
    if (variant === 'evidence') value.models[0].tariffs[0].components.input.provenance.authority = 'operator';
    if (variant === 'calendar') value.publishedAt = '2026-02-30T00:00:00Z';
    value.revision = digest(json(payload(value)));
    value.sha256 = value.revision;
    expect(() => validateSnapshot(json(value))).toThrow();
  }
});

test('rejects divergent ancestry and custom-source failure never contacts the default', async () => {
  const good = githubFixture();
  const instance = loader({}, { getBytes: async url => url.includes('/compare/')
    ? Buffer.from(json({ status: 'diverged' })) : good(url) });
  await instance.start();
  expect(instance.capture()).toBeNull();
  const get = jest.fn().mockRejectedValue(new Error('https://secret:password@mirror.invalid'));
  const report = jest.fn();
  const custom = loader({ source: 'https://mirror.invalid/snapshot', trustSource: true }, { getBytes: get, report });
  await custom.start();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][0]).toBe('https://mirror.invalid/snapshot');
  expect(JSON.stringify(report.mock.calls)).not.toContain('password');
});

test('offline, disabled and local-only make zero feed network requests', async () => {
  const get = jest.fn();
  for (const options of [
    { offline: true }, { enabled: false },
    { localSnapshot: publication().snapshot, trustSource: true },
  ]) {
    const instance = loader(options, { getBytes: get });
    await instance.start();
    await instance.refresh();
  }
  expect(get).not.toHaveBeenCalled();
  expect(() => loader({ source: 'https://mirror.invalid' })).toThrow('trust');
  expect(() => loader({ localSnapshot: publication().snapshot })).toThrow('trust');
});

test('single-flight startup/refresh, immutable request selection and failed refresh preservation', async () => {
  let pub = publication('2');
  const get = url => githubFixture(pub)(url);
  const instance = loader({}, { getBytes: get });
  expect(instance.start()).toBe(instance.start());
  await instance.start();
  const pinned = instance.capture();
  pub = publication('4', NEXT);
  const first = instance.refresh();
  expect(instance.refresh()).toBe(first);
  await first;
  const usage = { input_tokens: 1_000_000 };
  expect(applyAiCreditsUsage(usage, 'loader-test', 'copilot', { catalogue: pinned }).aiCreditsThisResponse).toBe(200);
  expect(applyAiCreditsUsage(usage, 'loader-test', 'copilot', { catalogue: instance.capture() }).aiCreditsThisResponse).toBe(400);
  const previous = fs.readFileSync(path.join(directory, 'cache', fs.readdirSync(path.join(directory, 'cache'))[0]));
  pub.bytes = 'invalid';
  await instance.refresh();
  expect(instance.capture().revision).toBe(publication('4', NEXT).snapshot.revision);
  expect(fs.readFileSync(path.join(directory, 'cache', fs.readdirSync(path.join(directory, 'cache'))[0]))).toEqual(previous);
});

test('approved rollback reuses original snapshot and time but advances accepted source', async () => {
  const pub = publication();
  pub.pointer.sourceCommit = NEXT;
  const instance = loader({}, { getBytes: githubFixture(pub) });
  await instance.start();
  expect(instance.capture()?.snapshot).toMatchObject({ sourceCommit: FIRST, publishedAt: '2026-10-22T00:00:00.000Z' });
  expect(instance.reflect().sourceCommit).toBe(NEXT);
});

test('freshness uses evidence and effective intervals, not fetch time or fresh sibling facts', async () => {
  let clock = NOW;
  const instance = loader({}, { getBytes: githubFixture(), now: () => clock });
  await instance.start();
  const pinned = instance.capture();
  clock += 31 * 24 * 3600 * 1000;
  expect(instance.capture()).toBeNull();
  expect(resolveCentralPricing('copilot', 'loader-test', 0, pinned)).not.toBeNull();
  const expired = structuredClone(pinned);
  expired.snapshot.models[0].tariffs[0].effectiveUntil = new Date(NOW - 1).toISOString();
  expect(resolveCentralPricing('copilot', 'loader-test', 0, expired)).toBeNull();
  const stale = structuredClone(pinned);
  stale.snapshot.models[0].tariffs[0].components.input.provenance.at = '2000-01-01T00:00:00Z';
  expect(resolveCentralPricing('copilot', 'loader-test', 0, stale)).toBeNull();
});

test('provider/channel/deployment scopes and unsupported harness/tariff activation fail closed', async () => {
  const instance = loader({ localSnapshot: publication().snapshot, trustSource: true });
  await instance.start();
  expect(resolveCentralPricing('openai', 'loader-test', 0, instance.capture())).toBeNull();
  expect(resolveCentralPricing('copilot', 'loader-test', 0, instance.capture(), { channel: 'native-api' })).toBeNull();
  expect(resolveCentralPricing('copilot', 'loader-test', 0, instance.capture(), { deployment: 'enterprise' })).toBeNull();
  for (const variant of ['harness', 'tariff']) {
    const catalog = catalogue();
    if (variant === 'harness') catalog.models[0].harnesses = [{
      scope: { provider: 'copilot', channel: 'copilot-cli' }, name: 'copilot',
      minimum: '100.0.0', scheme: 'semver', reason: 'future requirement',
      provenance: catalog.models[0].provenance,
    }];
    else catalog.models[0].tariffs[0].unit = 'USD_PER_IMAGE';
    const snapshot = JSON.parse(buildSnapshot(catalog, FIRST, '2026-10-22T00:00:00Z'));
    const rejected = loader({ localSnapshot: snapshot, trustSource: true });
    await rejected.start();
    expect(rejected.capture()).toBeNull();
  }
});

test('source/schema partitioned private atomic cache survives offline startup, rejects unsafe files', async () => {
  const online = loader({}, { getBytes: githubFixture() });
  await online.start();
  const offline = loader({ offline: true }, { getBytes: jest.fn() });
  await offline.start();
  expect(offline.capture()?.revision).toBe(online.capture().revision);
  const other = loader({ offline: true, source: 'https://mirror.invalid', trustSource: true });
  await other.start();
  expect(other.capture()).toBeNull();
  const cache = path.join(directory, 'cache', fs.readdirSync(path.join(directory, 'cache'))[0]);
  expect(fs.statSync(cache).mode & 0o777).toBe(0o600);
  fs.chmodSync(cache, 0o644);
  const unsafe = loader({ offline: true });
  await unsafe.start();
  expect(unsafe.capture()).toBeNull();
});

test('cache reads use the checked descriptor even if its pathname is replaced', async () => {
  const online = loader({}, { getBytes: githubFixture() });
  await online.start();
  const cache = path.join(directory, 'cache', fs.readdirSync(path.join(directory, 'cache'))[0]);
  const stat = fs.fstatSync.bind(fs);
  jest.spyOn(fs, 'fstatSync').mockImplementation(fd => {
    const result = stat(fd);
    fs.renameSync(cache, `${cache}.original`);
    fs.writeFileSync(cache, 'untrusted replacement', { mode: 0o600 });
    return result;
  });
  const offline = loader({ offline: true });
  await offline.start();
  expect(offline.capture()?.revision).toBe(online.capture().revision);
});

test('cache symlinks are rejected without reading their target', async () => {
  const online = loader({}, { getBytes: githubFixture() });
  await online.start();
  const cache = path.join(directory, 'cache', fs.readdirSync(path.join(directory, 'cache'))[0]);
  fs.renameSync(cache, `${cache}.original`);
  fs.symlinkSync(`${cache}.original`, cache);
  const read = jest.spyOn(fs, 'readSync');
  const offline = loader({ offline: true });
  await offline.start();
  expect(offline.capture()).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test('unsafe cache directories fail explicitly without silently changing permissions', async () => {
  const shared = path.join(directory, 'shared');
  fs.mkdirSync(shared, { mode: 0o755 });
  const instance = loader({ cacheDirectory: shared }, { getBytes: githubFixture() });
  await instance.start();
  expect(instance.capture()).toBeNull();
  expect(instance.reflect().failure).toBe('catalogue_cache_permissions');
  expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
  const link = path.join(directory, 'linked');
  fs.symlinkSync(shared, link, 'dir');
  const linked = loader({ cacheDirectory: link }, { getBytes: githubFixture() });
  await linked.start();
  expect(linked.capture()).toBeNull();
  expect(linked.reflect().failure).toBe('catalogue_cache_permissions');
  expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
});

test('cached source ordering uses only candidate-selected remote history, bounded to ten pages', async () => {
  const online = loader({}, { getBytes: githubFixture() });
  await online.start();
  const get = githubFixture(publication('4', NEXT));
  const history = jest.fn(async url => {
    if (url.includes('/commits?')) return Buffer.from(json(Array.from({ length: 100 }, () => ({ sha: NEXT }))));
    return get(url);
  });
  const restarted = loader({}, { getBytes: history });
  await restarted.start();
  expect(restarted.capture()?.revision).toBe(online.capture().revision);
  expect(restarted.reflect().failure).toBe('catalogue_source_history_unavailable');
  const queries = history.mock.calls.filter(([url]) => url.includes('/commits?'));
  expect(queries).toHaveLength(10);
  expect(queries.every(([url]) => url.includes(`sha=${NEXT}`) && !url.includes(FIRST))).toBe(true);
});

test('complete fresh provider prices win, partial provider loses to feed, runtime request rates stay pinned', async () => {
  const instance = loader({ localSnapshot: publication().snapshot, trustSource: true });
  await instance.start();
  const options = { catalogue: instance.capture() };
  const record = { id: 'loader-test', observedAt: new Date(NOW).toISOString(),
    pricing: { default: { input: 9, output: 9, cachedInput: 9, cacheWrite: 9 } } };
  replaceRuntimeModels('copilot', [record]);
  expect(applyAiCreditsUsage({ input_tokens: 1e6 }, 'loader-test', 'copilot', options).pricingSource).toBe('provider');
  const pinned = captureRuntimePricing();
  clearRuntimeModels();
  replaceRuntimeModels('copilot', [{ ...record, pricing: { default: { input: 8, output: 8 } } }]);
  expect(applyAiCreditsUsage({ input_tokens: 1e6 }, 'loader-test', 'copilot', options).pricingSource).toBe('central_feed');
  expect(applyAiCreditsUsage({ input_tokens: 1e6 }, 'loader-test', 'copilot',
    { ...options, runtimeCatalog: pinned }).aiCreditsThisResponse).toBe(900);
});

test('configured v1 and operator authorities remain above runtime central prices; BYOK cannot inherit them', async () => {
  const keys = ['AWF_MODEL_PRICING_CATALOG', 'AWF_API_PROXY_PROVIDERS', 'COPILOT_PROVIDER_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const instance = loader({ localSnapshot: publication().snapshot, trustSource: true });
  await instance.start();
  const usage = () => applyAiCreditsUsage({ input_tokens: 1e6 }, 'loader-test', 'copilot', { catalogue: instance.capture() });
  try {
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'configured', version: 'v1',
      providers: { copilot: { models: { 'loader-test': {
        input: 3, output: 4, cachedInput: 1, cacheWrite: null, reasoning: 4,
      } } } },
    });
    resetModelPricingCatalogForTests();
    expect(usage()).toMatchObject({ pricingSource: 'shared_catalog', aiCreditsThisResponse: 300 });
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      copilot: { models: { 'loader-test': { cost: { input: '0.000005', output: '0.000006', cache_read: '0' } } } },
    });
    resetProviderPricingOverlaysForTests();
    expect(usage()).toMatchObject({ pricingSource: 'operator', aiCreditsThisResponse: 500 });
    delete process.env.AWF_API_PROXY_PROVIDERS;
    delete process.env.AWF_MODEL_PRICING_CATALOG;
    resetModelPricingCatalogForTests();
    resetProviderPricingOverlaysForTests();
    process.env.COPILOT_PROVIDER_API_KEY = 'fixture-byok-not-a-real-key';
    expect(usage()).toBeNull();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetModelPricingCatalogForTests();
    resetProviderPricingOverlaysForTests();
  }
});

test('honors strict long-context thresholds, unit conversion and promotion successor times', async () => {
  const data = catalogue();
  const base = data.models[0].tariffs[0];
  base.effectiveUntil = new Date(NOW).toISOString();
  base.promotion = 'reviewed fixture';
  base.successor = 'post_promotion';
  const successor = structuredClone(base);
  delete successor.effectiveUntil;
  delete successor.promotion;
  delete successor.successor;
  successor.effectiveFrom = new Date(NOW).toISOString();
  successor.tier = 'post_promotion';
  successor.components.input.price = '0.000004';
  successor.unit = 'USD_PER_TOKEN';
  const long = structuredClone(successor);
  long.tier = 'long_context';
  long.promptTokensAbove = 100000;
  long.components.input.price = '0.000008';
  data.models[0].tariffs = [base, successor, long];
  const value = JSON.parse(buildSnapshot(data, FIRST, '2026-10-22T00:00:00Z'));
  const instance = loader({ localSnapshot: value, trustSource: true });
  await instance.start();
  expect(resolveCentralPricing('copilot', 'loader-test', 100000, instance.capture()))
    .toMatchObject({ tier: 'post_promotion', pricing: { input: 4 } });
  expect(resolveCentralPricing('copilot', 'loader-test', 100001, instance.capture()))
    .toMatchObject({ tier: 'long_context', pricing: { input: 8 } });
  const staleLong = structuredClone(instance.capture());
  staleLong.snapshot.models[0].tariffs[2].components.input.provenance.at = '2000-01-01T00:00:00Z';
  expect(resolveCentralPricing('copilot', 'loader-test', 100001, staleLong)).toBeNull();
  expect(resolveCentralPricing('copilot', 'loader-test', 100000, staleLong)).not.toBeNull();
});

test('expired accepted cache still prevents source regression after restart', async () => {
  const newer = publication('4', NEXT);
  const online = loader({}, { getBytes: githubFixture(newer) });
  await online.start();
  const restarted = loader({ maxAgeSeconds: 1 }, { getBytes: githubFixture(publication()) });
  await restarted.start();
  expect(restarted.capture()).toBeNull();
  expect(restarted.reflect().failure).toBe('catalogue_source_regression');
});

test('scheduled refresh activates only later captures and stops cleanly', async () => {
  let interval;
  const timer = { unref: jest.fn() };
  const schedule = jest.spyOn(global, 'setInterval').mockImplementation(callback => {
    interval = callback;
    return timer;
  });
  const clear = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
  let pub = publication();
  const instance = loader({ refreshSeconds: 60 }, { getBytes: url => githubFixture(pub)(url) });
  await instance.start();
  const before = instance.capture();
  pub = publication('4', NEXT);
  await interval();
  expect(instance.capture().revision).not.toBe(before.revision);
  expect(before.snapshot.models[0].tariffs[0].components.input.price).toBe('2');
  expect(Object.isFrozen(before.snapshot.models[0].tariffs[0])).toBe(true);
  await instance.stop();
  expect(clear).toHaveBeenCalledWith(timer);
  expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60000);
});

test.each([301, 403, 404, 429, 500])('transport rejects HTTP %s without following redirects', async statusCode => {
  const request = new EventEmitter();
  request.destroy = jest.fn(error => request.emit('error', error));
  const spy = jest.spyOn(https, 'get').mockImplementation((_url, _options, callback) => {
    const response = new PassThrough();
    response.statusCode = statusCode;
    response.headers = { location: 'https://attacker.invalid' };
    queueMicrotask(() => callback(response));
    return request;
  });
  await expect(getBytes('https://example.invalid/catalogue', { timeoutMs: 100 })).rejects.toThrow(`catalogue_http_${statusCode}`);
  request.emit('close');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

test('bounded transport timeout, oversized/malformed data, cancellation and shutdown', async () => {
  const request = new EventEmitter();
  request.destroy = error => { request.emit('error', error); request.emit('close'); };
  jest.spyOn(https, 'get').mockReturnValue(request);
  await expect(getBytes('https://example.invalid/catalogue', { timeoutMs: 10 })).rejects.toThrow('catalogue_timeout');
  for (const bytes of [Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.from('{')]) {
    const instance = loader({ source: 'https://mirror.invalid', trustSource: true }, { getBytes: async () => bytes });
    await instance.start();
    expect(instance.capture()).toBeNull();
  }
  const stalled = loader({}, { getBytes: (_url, { signal }) => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const starting = stalled.start();
  await stalled.stop();
  await starting;
  expect(stalled.capture()).toBeNull();
});
