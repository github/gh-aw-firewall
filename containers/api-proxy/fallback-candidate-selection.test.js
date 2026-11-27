'use strict';

jest.mock('./model-recovery', () => ({
  ...jest.requireActual('./model-recovery'),
  getAutomaticRecoveryCandidates: jest.fn(),
}));

const { getRouteRejection, selectFallbackCandidate, buildFallbackCandidates } = require('./fallback-candidate-selection');
const { attemptKey } = require('./model-fallback-chain');
const { MAX_AUTOMATIC_RECOVERIES, getAutomaticRecoveryCandidates } = require('./model-recovery');

function selection(overrides = {}) {
  return {
    provider: 'copilot',
    origin: { provider: 'openai', protocol: 'chat', sourceBody: Buffer.from('{"model":"first"}') },
    attempted: [{ provider: 'openai', model: 'first' }],
    isPermitted: () => true,
    getProviderAdapter: () => ({ isEnabled: () => true }),
    ...overrides,
  };
}

beforeEach(() => {
  getAutomaticRecoveryCandidates.mockReset().mockReturnValue(['auto-next', 'auto-last']);
});

test.each(['copilot', 'openai'])('current and origin provider routes do not need a new adapter: %s', provider => {
  const getProviderAdapter = jest.fn(() => { throw new Error('not a cross-provider route'); });
  expect(getRouteRejection({ provider }, selection({ getProviderAdapter }))).toBeNull();
  expect(getProviderAdapter).not.toHaveBeenCalled();
});

test.each([
  ['gemini', 'chat', true, 'provider_unsupported'],
  ['openai', 'messages', true, 'protocol_unsupported'],
  ['anthropic', null, true, 'protocol_unsupported'],
  ['anthropic', 'chat', false, 'provider_not_configured'],
  ['anthropic', 'chat', true, null],
])('cross-provider route rejection: %s, %s, enabled=%s', (provider, protocol, enabled, expected) => {
  expect(getRouteRejection({ provider }, selection({
    provider: 'copilot', origin: { provider: 'copilot', protocol },
    getProviderAdapter: () => ({ isEnabled: () => enabled }),
  }))).toBe(expected);
});

test('missing adapters are rejected without dispatch', () => {
  expect(getRouteRejection({ provider: 'anthropic' }, selection({ getProviderAdapter: undefined })))
    .toBe('provider_not_configured');
});

test('selection preserves origin-relative entries, attempt exclusions, target guards, and chain order', () => {
  const chain = ['first', 'excluded', 'gemini/unsupported', 'anthropic/blocked', 'anthropic/next', 'last'];
  const attempted = [{ provider: 'openai', model: 'FIRST' }];
  const exclude = new Set([attemptKey('openai', 'excluded')]);
  const onSkip = jest.fn();
  const isPermitted = jest.fn(model => model !== 'blocked');
  const candidate = selectFallbackCandidate(chain, selection({ attempted, exclude, onSkip, isPermitted }));
  expect(candidate).toMatchObject({ entry: 'anthropic/next', provider: 'anthropic', model: 'next' });
  expect(onSkip.mock.calls.map(([candidate, reason]) => [candidate.entry, reason])).toEqual([
    ['gemini/unsupported', 'provider_unsupported'], ['anthropic/blocked', 'guard_rejected'],
  ]);
  expect(isPermitted.mock.calls).toEqual([['blocked', 'anthropic'], ['next', 'anthropic']]);
  expect(chain).toHaveLength(6);
  expect(attempted).toEqual([{ provider: 'openai', model: 'FIRST' }]);
  expect([...exclude]).toEqual([attemptKey('openai', 'excluded')]);
  expect(selectFallbackCandidate(['last'], selection())).toMatchObject({ provider: 'openai', model: 'last' });
});

test.each([
  [{ getProviderAdapter: () => { throw new Error('unavailable'); } }, 'route_unavailable'],
  [{ isPermitted: () => { throw new Error('unavailable'); } }, 'guard_rejected'],
  [{ isPermitted: () => 'truthy but not permitted' }, 'guard_rejected'],
])('selection fails closed on invalid admission results: %j', (overrides, reason) => {
  const onSkip = jest.fn();
  expect(selectFallbackCandidate(['anthropic/next'], selection({ ...overrides, onSkip }))).toBeNull();
  expect(onSkip).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'next' }), reason);
});

test.each(['model_not_supported', 'model_endpoint_incompatible'])(
  'appends automatic recovery after the explicit chain for %s without mutating inputs',
  reason => {
    const params = {
      ...selection(), chain: ['explicit'], automaticRecovery: true, reason,
      req: { url: '/v1/responses' },
    };
    expect(buildFallbackCandidates(params)).toEqual(['explicit', 'copilot/auto-next', 'copilot/auto-last']);
    expect(getAutomaticRecoveryCandidates).toHaveBeenCalledWith({
      model: 'first', provider: 'copilot', body: params.origin.sourceBody,
      url: params.req.url, req: params.req, isPermitted: params.isPermitted,
    });
    expect(params.chain).toEqual(['explicit']);
    expect(params.req).toEqual({ url: '/v1/responses' });
  },
);

test.each([
  [false, 'model_not_supported', {}],
  [true, 'upstream_5xx', {}],
  [true, 'model_not_supported', { awfAutomaticRecoveryCount: MAX_AUTOMATIC_RECOVERIES }],
  [true, 'model_endpoint_incompatible', { awfAutomaticRecoveryCount: MAX_AUTOMATIC_RECOVERIES + 1 }],
])('does not expand recovery outside its reason and attempt budget: %s, %s, %j',
  (automaticRecovery, reason, req) => {
    expect(buildFallbackCandidates({
      ...selection(), chain: ['explicit'], automaticRecovery, reason, req,
    })).toEqual(['explicit']);
    expect(getAutomaticRecoveryCandidates).not.toHaveBeenCalled();
  },
);

test('recovery attempts without an explicit count still allow expansion below the limit', () => {
  const req = { url: '/v1/responses', awfRecoveryAttempts: [{ provider: 'openai', model: 'first' }] };
  expect(buildFallbackCandidates({
    ...selection(), chain: [], automaticRecovery: true, reason: 'model_not_supported', req,
  })).toEqual(['copilot/auto-next', 'copilot/auto-last']);
});

test('preserves configured wire spelling on custom-host fallback targets while canonicalizing native adapters', () => {
  const customAdapter = { getTargetHost: () => 'gateway.example.com', getTargetScheme: () => 'https' };
  const nativeAdapter = { getTargetHost: () => 'api.openai.com', getTargetScheme: () => 'https' };
  expect(selectFallbackCandidate(['GPT-5.4'], selection({
    getProviderAdapter: () => customAdapter,
  }))).toMatchObject({ provider: 'openai', model: 'GPT-5.4' });
  expect(selectFallbackCandidate(['openai/GPT-5.4'], selection({
    origin: { provider: 'copilot', protocol: 'chat', sourceBody: Buffer.from('{"model":"first"}') },
    provider: 'copilot',
    getProviderAdapter: name => name === 'openai' ? { ...customAdapter, isEnabled: () => true } : null,
  }))).toMatchObject({ provider: 'openai', model: 'GPT-5.4' });
  expect(selectFallbackCandidate(['GPT-5.4'], selection({
    getProviderAdapter: () => nativeAdapter,
  }))).toMatchObject({ provider: 'openai', model: 'gpt-5.4' });
});
