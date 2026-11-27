'use strict';

const { BaseOidcTokenProvider, MIN_RETRY_DELAY_MS } = require('./oidc-token-provider-base');

class TestOidcTokenProvider extends BaseOidcTokenProvider {
  constructor(config = {}) {
    super('test_oidc', config);
    this._cachedValue = null;
  }

  async _doRefresh() {}

  _getCachedValue() {
    return this._cachedValue;
  }

  _setCachedValue(value) {
    this._cachedValue = value;
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

  it('uses a fractional clock by default', () => {
    jest.useFakeTimers({ now: 100_900 });
    const provider = new TestOidcTokenProvider();
    try {
      expect(provider._nowSeconds()).toBe(100.9);
    } finally {
      provider.shutdown();
      jest.useRealTimers();
    }
  });

  it('keeps a token issued near a second boundary valid until its refresh runs', async () => {
    jest.useFakeTimers({ now: 100_900 });
    const provider = new TestOidcTokenProvider();
    provider._doRefresh = jest.fn(async () => {
      provider._storeAndScheduleRefresh('refreshed-token', 1);
    });
    try {
      provider._storeAndScheduleRefresh('cached-token', 1);
      expect(provider._expiresAt).toBe(101.9);

      await jest.advanceTimersByTimeAsync(749);
      expect(provider.isReady()).toBe(true);
      expect(provider.getToken()).toBe('cached-token');
      expect(provider._doRefresh).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(provider._doRefresh).toHaveBeenCalledTimes(1);
      expect(provider.getToken()).toBe('refreshed-token');
    } finally {
      provider.shutdown();
      jest.useRealTimers();
    }
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

describe('BaseOidcTokenProvider refresh retries', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a failed refresh before the token expires', async () => {
    jest.useFakeTimers({ now: 0 });
    const provider = new TestOidcTokenProvider();
    provider._doRefresh = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async () => {
        provider._storeAndScheduleRefresh('refreshed-token', 60);
      });
    try {
      provider._storeAndScheduleRefresh('cached-token', 60);

      await jest.advanceTimersByTimeAsync(45_000);
      expect(provider._doRefresh).toHaveBeenCalledTimes(1);
      expect(provider.isReady()).toBe(true);

      await jest.advanceTimersByTimeAsync(7_499);
      expect(provider._doRefresh).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(provider._doRefresh).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBeLessThan(60_000);
      expect(provider.getToken()).toBe('refreshed-token');
    } finally {
      provider.shutdown();
    }
  });

  it('keeps retrying with a positive backoff after the token expires', async () => {
    jest.useFakeTimers({ now: 0 });
    const provider = new TestOidcTokenProvider({ retryDelayMs: 5_000 });
    let resolveSlowRefresh;
    provider._doRefresh = jest.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => {
        resolveSlowRefresh = () => reject(new Error('slow failure'));
      }))
      .mockRejectedValueOnce(new Error('still failing'))
      .mockImplementation(async () => {
        provider._storeAndScheduleRefresh('refreshed-token', 60);
      });
    try {
      provider._storeAndScheduleRefresh('cached-token', 2);
      await jest.advanceTimersByTimeAsync(1_500);
      expect(provider._doRefresh).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(provider.isReady()).toBe(false);
      resolveSlowRefresh();
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(provider._doRefresh).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(provider._doRefresh).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(provider._doRefresh).toHaveBeenCalledTimes(3);
      expect(provider.isReady()).toBe(true);
      expect(provider.getToken()).toBe('refreshed-token');
    } finally {
      provider.shutdown();
    }
  });

  it.each([
    [{ expiresAt: 60, now: 45 }, 7_500],
    [{ expiresAt: 60, now: 0 }, 30_000],
    [{ expiresAt: 60, now: 59.5 }, MIN_RETRY_DELAY_MS],
    [{ expiresAt: 60, now: 60 }, 30_000],
    [{ expiresAt: 60, now: 120 }, 30_000],
  ])('caps retry delay against remaining lifetime (%j)', ({ expiresAt, now }, delayMs) => {
    jest.useFakeTimers({ now: now * 1000 });
    const provider = new TestOidcTokenProvider();
    provider._expiresAt = expiresAt;
    try {
      expect(provider._getRetryDelayMs()).toBe(delayMs);
    } finally {
      provider.shutdown();
    }
  });
});
