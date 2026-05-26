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
