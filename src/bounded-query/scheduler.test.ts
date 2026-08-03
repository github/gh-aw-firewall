import * as path from 'path';

/**
 * Unit tests for response-timing bucketing.
 *
 * A query's raw completion latency is itself a secret-dependent signal; the
 * broker must make every launched invocation's *observable* response time
 * land on one of six fixed boundaries (10ms, 100ms, 1s, 10s, 1m, 10m),
 * using a monotonic clock, regardless of how long the underlying work took.
 * These tests use a fully deterministic fake clock (no real elapsed time)
 * to avoid any flakiness from real-time assertions.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker');
const {
  TIMING_BUCKETS_MS,
  TIMER_WAKE_TOLERANCE_MS,
  resolveTimingBucket,
  createRealClock,
  waitForBucket,
} = require(
  path.join(brokerDir, 'scheduler.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

interface FakeClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
  sleepCalls: number[];
}

/** A fake monotonic clock: `nowMs()` only moves via explicit `advance()`, and `sleep()` advances time itself (as a real clock would while paused). */
function createFakeClock(startMs = 0): FakeClock {
  let now = startMs;
  const sleepCalls: number[] = [];
  return {
    nowMs: () => now,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleepCalls,
  };
}

describe('TIMING_BUCKETS_MS', () => {
  it('is exactly the six documented boundaries, ascending', () => {
    expect(TIMING_BUCKETS_MS).toEqual([10, 100, 1000, 10000, 60000, 600000]);
  });
});

describe('resolveTimingBucket', () => {
  it('resolves 0ms elapsed to the smallest (10ms) bucket', () => {
    expect(resolveTimingBucket(0)).toEqual({ bucketMs: 10, overflowed: false });
  });

  it.each([
    [10, 10],
    [11, 100],
    [100, 100],
    [101, 1000],
    [1000, 1000],
    [1001, 10000],
    [10000, 10000],
    [10001, 60000],
    [60000, 60000],
    [60001, 600000],
    [600000, 600000],
  ])('elapsed=%ims resolves to bucket=%ims (inclusive boundaries)', (elapsedMs, expectedBucketMs) => {
    expect(resolveTimingBucket(elapsedMs)).toEqual({ bucketMs: expectedBucketMs, overflowed: false });
  });

  it('marks anything past the last (600000ms) bucket as overflowed', () => {
    expect(resolveTimingBucket(600001)).toEqual({ bucketMs: 600000, overflowed: true });
    expect(resolveTimingBucket(10_000_000)).toEqual({ bucketMs: 600000, overflowed: true });
  });
});

describe('createRealClock', () => {
  it('exposes a monotonic nowMs derived from process.hrtime.bigint, and a setTimeout-based sleep', async () => {
    const clock = createRealClock();
    const before = clock.nowMs();
    expect(typeof before).toBe('number');
    await clock.sleep(1);
    const after = clock.nowMs();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('waitForBucket (fake clock — fully deterministic, no real time elapsed)', () => {
  it('waits the remainder of the bucket when processing finished early', async () => {
    const clock = createFakeClock(1000);
    clock.advance(3); // 3ms of "processing" already elapsed on the clock
    const result = await waitForBucket(1000, 3, clock); // elapsed=3ms -> bucket=10ms
    expect(result).toEqual({ bucketMs: 10, overflowed: false });
    expect(clock.sleepCalls).toEqual([7]); // 10 - 3
    expect(clock.nowMs()).toBe(1010);
  });

  it('does not sleep at all when processing lands exactly on the bucket boundary', async () => {
    const clock = createFakeClock(5000);
    clock.advance(100); // processing consumed exactly the 100ms bucket
    const result = await waitForBucket(5000, 100, clock); // elapsed exactly at 100ms bucket
    expect(result).toEqual({ bucketMs: 100, overflowed: false });
    expect(clock.sleepCalls).toEqual([]);
    expect(clock.nowMs()).toBe(5100);
  });

  it('re-resolves to a later fixed boundary when the initially selected boundary has passed', async () => {
    const clock = createFakeClock(1000);
    clock.advance(50); // now = 1050, past startMs(1000) + bucket(10) = 1010
    const result = await waitForBucket(1000, 3, clock);
    expect(result).toEqual({ bucketMs: 100, overflowed: false });
    expect(clock.sleepCalls).toEqual([50]);
    expect(clock.nowMs()).toBe(1100);
  });

  it('re-buckets a timer wake-up later than the public scheduler tolerance', async () => {
    let now = 3;
    const sleepCalls: number[] = [];
    const clock = {
      nowMs: () => now,
      sleep: (ms: number) => {
        sleepCalls.push(ms);
        now += ms + (sleepCalls.length === 1 ? TIMER_WAKE_TOLERANCE_MS + 1 : 0);
        return Promise.resolve();
      },
    };

    const result = await waitForBucket(0, 3, clock);

    expect(result).toEqual({ bucketMs: 100, overflowed: false });
    expect(sleepCalls).toEqual([7, 84]);
    expect(now).toBe(100);
  });

  it('preserves the final bucket when only the public scheduler wake is late', async () => {
    let now = 500_000;
    const sleepCalls: number[] = [];
    const clock = {
      nowMs: () => now,
      sleep: (ms: number) => {
        sleepCalls.push(ms);
        now += ms + TIMER_WAKE_TOLERANCE_MS + 1;
        return Promise.resolve();
      },
    };

    const result = await waitForBucket(0, 500_000, clock);

    expect(result).toEqual({ bucketMs: 600_000, overflowed: false });
    expect(sleepCalls).toEqual([100_000]);
    expect(now).toBe(600_000 + TIMER_WAKE_TOLERANCE_MS + 1);
  });

  it('selects successively larger buckets as elapsed time grows', async () => {
    const cases: Array<[number, number]> = [
      [5, 10],
      [50, 100],
      [500, 1000],
      [5000, 10000],
      [50000, 60000],
      [500000, 600000],
    ];
    for (const [elapsedMs, expectedBucketMs] of cases) {
      const clock = createFakeClock(0);
      clock.advance(elapsedMs);
      // eslint-disable-next-line no-await-in-loop
      const result = await waitForBucket(0, elapsedMs, clock);
      expect(result.bucketMs).toBe(expectedBucketMs);
      expect(result.overflowed).toBe(false);
      expect(clock.sleepCalls).toEqual([expectedBucketMs - elapsedMs]);
    }
  });

  it('reports overflow (and never sleeps) once elapsed processing exceeds the last bucket', async () => {
    const clock = createFakeClock(0);
    const result = await waitForBucket(0, 600001, clock);
    expect(result).toEqual({ bucketMs: 600000, overflowed: true });
    expect(clock.sleepCalls).toEqual([]);
  });

  it('never lets sleep duration itself vary with the exact sub-bucket elapsed time beyond the bucket granularity', async () => {
    // Two invocations with different elapsed processing times, both inside
    // the same bucket window, must each independently reach exactly the
    // bucket boundary from their own start point — i.e. the *absolute*
    // response time (startMs + bucketMs) is what's fixed, not a constant
    // sleep duration.
    const clockA = createFakeClock(0);
    clockA.advance(1);
    await waitForBucket(0, 1, clockA);
    expect(clockA.nowMs()).toBe(10);

    const clockB = createFakeClock(0);
    clockB.advance(9);
    await waitForBucket(0, 9, clockB);
    expect(clockB.nowMs()).toBe(10);
  });
});
