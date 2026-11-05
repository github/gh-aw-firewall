'use strict';

const exact = require('../catalogue-contract/exact-pricing');
const guard = require('./ai-credits-guard');
const { parseProviderModelMetadata, replaceRuntimeModels, captureRuntimePricing, clearRuntimeModels } =
  require('../runtime-model-catalog');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');
let environment;
beforeEach(() => {
  environment = { ...process.env };
  for (const key of ['AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS',
    'AWF_MODEL_PRICING_CATALOG', 'AWF_API_PROXY_PROVIDERS']) delete process.env[key];
  guard.resetAiCreditsGuardForTests();
  clearRuntimeModels();
  collectLogOutput();
});
afterEach(() => { process.env = environment; clearRuntimeModels(); });
const configure = (input, rest = {}) => {
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({
    input, output: '0', cachedInput: '0', cacheWrite: null, ...rest,
  });
};
const charge = (tokens = 1, usage = {}, provider = 'openai', options = {}) =>
  guard.applyAiCreditsUsage({ input_tokens: tokens, ...usage }, 'exact-fixture', provider, {
    catalogue: null, ...options,
  });

test('decimal fractions, unit conversions, rounding ties and JSON output are deterministic', () => {
  configure('0.005');
  expect(charge().aiCreditsThisResponse).toBe(0.000001); // exactly half a microcredit
  configure('0.004999999999999999999999999999999999');
  expect(charge().aiCreditsThisResponse).toBe(0);
  configure('0.005000000000000000000000000000000001');
  expect(charge().aiCreditsThisResponse).toBe(0.000001);
  expect(() => JSON.stringify(guard.getAiCreditsReflectState())).not.toThrow();
  expect(typeof process.env.AWF_AI_CREDITS_USED).toBe('string');
});

test('many sub-output-unit charges equal one response without per-response rounding', () => {
  configure('0.00012345678901234567890123456789');
  for (let i = 0; i < 10000; i++) expect(charge().aiCreditsThisResponse).toBe(0);
  const many = guard.getAiCreditsReflectState();
  guard.resetAiCreditsGuardForTests();
  charge(10000);
  expect(guard.getAiCreditsReflectState()).toEqual(many);
  expect(many.total).toBe(0.000123);
  expect(many.by_model['exact-fixture'].total).toBe(0.000123);
});

test.each(['0.799999999999999999999999999999', '0.8', '0.800000000000000000000000000001'])(
  'steering uses the unrounded accumulated value %s', price => {
    configure(price);
    process.env.AWF_MAX_AI_CREDITS = '1';
    charge(10000);
    expect(guard.getAiCreditsReflectState().thresholds_crossed).toEqual(price.startsWith('0.799') ? [] : [80]);
  });

test.each(['0.99999999999999999999999999', '1', '1.00000000000000000000000001'])(
  'exact below/equal/above budget despite equal display %s', price => {
    configure(price);
    process.env.AWF_MAX_AI_CREDITS = '1';
    expect(charge(10000).totalAiCredits).toBe(1);
    expect(guard.getAiCreditsBlockState().maxExceeded).toBe(!price.startsWith('0.999'));
  });

test.each(['9999.999999999999999999999999', '10000', '10000.000000000000000000000001'])(
  'exact hard cap %s', price => {
    configure(price);
    charge(10000);
    expect(guard.getAiCreditsBlockState()?.hardCap === true).toBe(!price.startsWith('9999.'));
  });

test('long decimal configured limits are not shortened to their numeric display', () => {
  configure('1');
  process.env.AWF_MAX_AI_CREDITS = '1.0000000000000000000000000001';
  charge(10000);
  expect(guard.getAiCreditsBlockState()).toMatchObject({ maxAiCredits: 1, maxExceeded: false });
  configure('0.0000000000000000000000000001');
  charge(10000);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(true);
});

test('legacy numeric inputs retain only their available decimal representation', () => {
  configure(0.1 + 0.2);
  process.env.AWF_MAX_AI_CREDITS = '0.3';
  charge(10000);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(true);
  guard.resetAiCreditsGuardForTests();
  configure('0.299999999999999999999999999999999999');
  charge(10000);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(false);
});

test.each(['1', '10000'])('an already-exhausted %s limit stays exhausted after a pricing failure', limit => {
  configure(limit);
  process.env.AWF_MAX_AI_CREDITS = limit;
  charge(10000);
  configure('1e999');
  expect(() => charge()).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
  expect(guard.getAiCreditsBlockState()).toMatchObject({
    maxExceeded: true, ...(limit === '10000' ? { hardCap: true } : {}),
  });
});

test('additive/inclusive caches, explicit zero/null and reasoning retain component semantics', () => {
  configure('0.1', { cachedInput: '0.02', cacheWrite: '0.03', output: '0.7', reasoning: '0.9' });
  // (10*.1 + 3*.02 + 2*.03 + 3*.7 + 4*.9)/10000 = .000682
  const additive = charge(10, { cache_read_tokens: 3, cache_write_tokens: 2,
    output_tokens: 7, reasoning_tokens: 4 }, 'anthropic');
  expect(additive.aiCreditsThisResponse).toBe(0.000682);
  const inclusive = charge(10, { cache_read_tokens: 3, cache_write_tokens: 2,
    output_tokens: 7, reasoning_tokens: 4, input_tokens_include_cache: true }, 'copilot');
  expect(inclusive.aiCreditsThisResponse).toBe(0.000632);
  configure('0.1', { cacheWrite: '0' });
  expect(charge(0, { cache_write_tokens: 10 }, 'anthropic').aiCreditsThisResponse).toBe(0);
  configure('0.1', { cacheWrite: null });
  expect(charge(0, { cache_write_tokens: 10 }, 'anthropic').aiCreditsThisResponse).toBe(0);
});

test('provider batch division is exact, with request snapshots surviving refresh', () => {
  const provider = input => parseProviderModelMetadata('copilot', { data: [{
    id: 'exact-fixture', billing: { token_prices: { batch_size: '3', default: {
      input_price: input, output_price: '0', cache_read_price: '0', cache_write_price: '0',
    } } },
  }] });
  replaceRuntimeModels('copilot', provider('0.1'));
  const pinned = captureRuntimePricing();
  replaceRuntimeModels('copilot', provider('0.9'));
  process.env.AWF_MAX_AI_CREDITS = '0.1';
  charge(3, {}, 'copilot', { runtimeCatalog: pinned });
  expect(guard.getAiCreditsReflectState().total).toBe(0.1);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(true);
  charge(3, {}, 'copilot', { runtimeCatalog: captureRuntimePricing() });
  expect(guard.getAiCreditsReflectState().total).toBe(1);
});

test('operator per-token conversion preserves a long decimal below a budget boundary', () => {
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ openai: { models: {
    'exact-fixture': { cost: { input: '0.0000000099999999999999999999999999999', output: '0' } },
  } } });
  process.env.AWF_MAX_AI_CREDITS = '0.000001';
  expect(charge().aiCreditsThisResponse).toBe(0.000001);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(false);
});

test('invalid refreshed provider prices survive discovery instead of silently using previous/fallback prices', () => {
  const provider = input => parseProviderModelMetadata('copilot', { data: [{
    id: 'exact-fixture', billing: { token_prices: { batch_size: 1, default: {
      input_price: input, output_price: '0', cache_read_price: '0', cache_write_price: '0',
    } } },
  }] });
  replaceRuntimeModels('copilot', provider('0.1'));
  const pin = captureRuntimePricing();
  replaceRuntimeModels('copilot', provider('1e-999'));
  configure('1');
  // The old request still uses its valid capture, not the failed refresh.
  expect(charge(1, {}, 'copilot', { runtimeCatalog: pin }).aiCreditsThisResponse).toBe(0.1);
  expect(() => charge(1, {}, 'copilot')).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
  expect(guard.getAiCreditsReflectState().total).toBe(0.1);
  expect(guard.checkModelPricing('gpt-5.4', 'copilot').error.type).toBe('pricing_resolution_error');
});

test('partial provider components preserve exact lower-source cache rates', () => {
  configure('0', { cachedInput: '0.3333333333333333333333333333333333333333' });
  const options = { runtimeCatalog: { copilot: [{
    id: 'exact-fixture', pricing: { default: { input: '0.1', output: '0' } },
  }] } };
  process.env.AWF_MAX_AI_CREDITS = '1';
  expect(charge(0, { cache_read_tokens: 30000 }, 'copilot', options).aiCreditsThisResponse).toBe(1);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(false);
});

test.each(['1e-999', '1e999', '9'.repeat(421)])('invalid exact limit %s blocks preflight with a sanitized error', max => {
  process.env.AWF_MAX_AI_CREDITS = max;
  expect(guard.checkModelPricing('gpt-5.4', 'copilot').error.type).toBe('pricing_resolution_error');
  expect(guard.getAiCreditsBlockState()).toBeNull();
});

test.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('unsafe token count %s is not approximated', tokens => {
  configure('1');
  expect(() => charge(tokens)).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
  expect(guard.getAiCreditsReflectState()).toMatchObject({ total: 0, pricing_error: 'pricing_resolution_error' });
});

test('positive rates below Number range are retained, not silently priced as free', () => {
  configure('1e-350');
  process.env.AWF_MAX_AI_CREDITS = `0.${'0'.repeat(353)}1`; // 1e-354 credits
  charge();
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(true);
});

test.each(['1e999', '1e-999', '1e999999999', '9'.repeat(421), '-1', 'NaN', 'Infinity', '0x10'])(
  'unsupported decimal %s fails explicitly and blocks subsequent dispatch', input => {
    configure(input);
    expect(() => charge()).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
    expect(guard.checkModelPricing('gpt-5.4', 'copilot').error.type).toBe('pricing_resolution_error');
    expect(guard.getAiCreditsReflectState()).toMatchObject({ total: 0, pricing_error: 'pricing_resolution_error' });
  });

test('arithmetic is bounded and independently preserves decimal inputs', () => {
  expect(exact.compare(exact.add(exact.decimal('0.1'), exact.decimal('0.2')), exact.decimal('0.3'))).toBe(0);
  expect(exact.number(exact.divide(exact.decimal(1), exact.decimal(3)))).toBe(0.333333);
  expect(() => exact.decimal({ n: 1n, d: 1n })).toThrow();
  let large = exact.decimal('1e400');
  for (let i = 0; i < 9; i++) large = exact.multiply(large, exact.decimal('1e400'));
  expect(() => exact.multiply(large, exact.decimal('1e400'))).toThrow('pricing_decimal_out_of_range');
  expect(() => exact.number(exact.decimal(1), 1000000)).toThrow('pricing_decimal_invalid_places');
  for (const text of [' .1 ', '+0.1', '1.e-1', '1e-1']) {
    expect(exact.compare(exact.decimal(text), exact.decimal('0.1'))).toBe(0);
  }
});

test('nonrepresentable public totals error before committing a partial response charge', () => {
  configure('1e308');
  expect(() => charge(Number.MAX_SAFE_INTEGER)).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
  expect(guard.getAiCreditsReflectState()).toMatchObject({ total: 0, pricing_error: 'pricing_resolution_error' });
});

test('fractional nano-AIU rates retain their supplied decimal digits', () => {
  const records = parseProviderModelMetadata('copilot', { data: [{
    id: 'exact-fixture', billing: { token_prices: {
      batch_size: 1, input_price: '0.99999999999999999999999999999', output_price: '0',
      cache_read_price: '0', cache_write_price: '0',
    } },
  }] });
  replaceRuntimeModels('copilot', records);
  process.env.AWF_MAX_AI_CREDITS = '0.000001';
  expect(charge(1000, {}, 'copilot').aiCreditsThisResponse).toBe(0.000001);
  expect(guard.getAiCreditsBlockState().maxExceeded).toBe(false);
});
