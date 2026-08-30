import {
  GUARD_SNAPSHOT_INTERVAL_MS,
  areGuardContainersRemoved,
  captureGuardSnapshotPair,
  fetchProxyGuardSnapshot,
} from './guard-result-proxy';
import { AGENT_CONTAINER_NAME, API_PROXY_CONTAINER_NAME, SQUID_CONTAINER_NAME } from './constants';

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

function snapshotJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    proxy_id: 'proxy-1',
    generated_at: 1000,
    local_ai_credits_limit_rejections: 0,
    upstream_403_count: 0,
    final_event: null,
    final_event_at: null,
    ai_credits_total: 0,
    ai_credits_max: null,
    ...overrides,
  });
}

describe('fetchProxyGuardSnapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the parsed snapshot on success', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: snapshotJson({ proxy_id: 'abc' }) } as any);
    const snapshot = await fetchProxyGuardSnapshot();
    expect(snapshot?.proxy_id).toBe('abc');
    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['exec', API_PROXY_CONTAINER_NAME, 'wget', '-qO-', 'http://127.0.0.1:10000/guard-snapshot'],
      expect.any(Object),
    );
  });

  it('returns null when docker exec fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('container not running'));
    const snapshot = await fetchProxyGuardSnapshot();
    expect(snapshot).toBeNull();
  });

  it('returns null when the response is not valid JSON', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: 'not json' } as any);
    const snapshot = await fetchProxyGuardSnapshot();
    expect(snapshot).toBeNull();
  });

  it('returns null when the response is missing a proxy_id', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: JSON.stringify({ foo: 'bar' }) } as any);
    const snapshot = await fetchProxyGuardSnapshot();
    expect(snapshot).toBeNull();
  });
});

describe('captureGuardSnapshotPair', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns two snapshots when both fetches succeed', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: snapshotJson({ generated_at: 1 }) } as any)
      .mockResolvedValueOnce({ stdout: snapshotJson({ generated_at: 2 }) } as any);
    const pair = await captureGuardSnapshotPair(API_PROXY_CONTAINER_NAME, 1);
    expect(pair).not.toBeNull();
    expect(pair?.[0].generated_at).toBe(1);
    expect(pair?.[1].generated_at).toBe(2);
  });

  it('returns null when the first fetch fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('boom'));
    const pair = await captureGuardSnapshotPair(API_PROXY_CONTAINER_NAME, 1);
    expect(pair).toBeNull();
    expect(mockExecaFn).toHaveBeenCalledTimes(1);
  });

  it('returns null when the second fetch fails', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: snapshotJson() } as any)
      .mockRejectedValueOnce(new Error('boom'));
    const pair = await captureGuardSnapshotPair(API_PROXY_CONTAINER_NAME, 1);
    expect(pair).toBeNull();
  });

  it('uses the default interval constant when none is provided', () => {
    expect(GUARD_SNAPSHOT_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('areGuardContainersRemoved', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when none of the managed containers are listed', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: 'some-other-container\n' } as any);
    expect(await areGuardContainersRemoved()).toBe(true);
  });

  it('returns false when the agent container is still present', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: `${AGENT_CONTAINER_NAME}\n` } as any);
    expect(await areGuardContainersRemoved()).toBe(false);
  });

  it('returns false when the api-proxy container is still present', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: `${API_PROXY_CONTAINER_NAME}\n` } as any);
    expect(await areGuardContainersRemoved()).toBe(false);
  });

  it('returns false when the squid container is still present', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: `${SQUID_CONTAINER_NAME}\n` } as any);
    expect(await areGuardContainersRemoved()).toBe(false);
  });

  it('returns false when the docker command fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('docker not available'));
    expect(await areGuardContainersRemoved()).toBe(false);
  });
});
