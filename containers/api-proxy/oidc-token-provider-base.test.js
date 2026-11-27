'use strict';

const { BaseOidcTokenProvider } = require('./oidc-token-provider-base');

class TestOidcTokenProvider extends BaseOidcTokenProvider {
  constructor() {
    super('test_oidc', {});
    this._cachedValue = null;
  }

  async _doRefresh() {}

  _getCachedValue() {
    return this._cachedValue;
  }

  _getInitSuccessLogContext() {
    return {};
  }

  _getInitFailureLogContext() {
    return {};
  }
}

describe('BaseOidcTokenProvider#getToken', () => {
  it.each([
    [0.001, 1],
    [1, 750],
    [60, 45_000],
    [240, 180_000],
    [300, 225_000],
    [600, 450_000],
    [3600, 2_700_000],
  ])('refreshes a %s-second token at 75%% of its lifetime with a positive delay', (expiresIn, delayMs) => {
    const provider = new TestOidcTokenProvider();
    expect(provider._getRefreshDelayMs(expiresIn)).toBe(delayMs);
    provider.shutdown();
  });

  it('preserves the integer clock by default', () => {
    const provider = new TestOidcTokenProvider();
    expect(provider._nowSeconds()).toBe(Math.floor(Date.now() / 1000));
    provider.shutdown();
  });

  it('returns cached value when it has not expired', () => {
    const provider = new TestOidcTokenProvider();
    provider._cachedValue = 'cached-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 60;

    expect(provider.getToken()).toBe('cached-token');
    provider.shutdown();
  });

  it('returns null and schedules refresh when cache is expired', () => {
    const provider = new TestOidcTokenProvider();
    provider._cachedValue = 'stale-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) - 1;
    provider._scheduleRefresh = jest.fn();

    expect(provider.getToken()).toBeNull();
    expect(provider._scheduleRefresh).toHaveBeenCalledWith(0);
    provider.shutdown();
  });

  it('returns null without scheduling refresh when one is already in flight', () => {
    const provider = new TestOidcTokenProvider();
    provider._cachedValue = null;
    provider._refreshInFlight = Promise.resolve();
    provider._scheduleRefresh = jest.fn();

    expect(provider.getToken()).toBeNull();
    expect(provider._scheduleRefresh).not.toHaveBeenCalled();
    provider.shutdown();
  });
});
