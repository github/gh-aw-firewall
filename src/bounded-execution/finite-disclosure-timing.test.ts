import * as path from 'path';
import {
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  TIMING_BUCKET_BITS,
  TIMING_BUCKETS_MS,
} from './finite-disclosure';

/* eslint-disable @typescript-eslint/no-require-imports */
const containerRoot = path.join(__dirname, '..', '..', 'containers', 'bounded-execution');
const containerDisclosure = require(path.join(containerRoot, 'finite-disclosure.js')) as {
  MAX_ENCLAVE_TIMEOUT_SECONDS: number;
  TIMING_BUCKET_BITS: number;
  TIMING_BUCKETS_MS: number[];
};
const {
  MAX_RESPONSE_JITTER_MS,
  TIMER_WAKE_TOLERANCE_MS,
  resolveTimingBucket,
  waitForBucket,
} = require(path.join(containerRoot, 'fixed-timing.js')) as {
  MAX_RESPONSE_JITTER_MS: number;
  TIMER_WAKE_TOLERANCE_MS: number;
  resolveTimingBucket: (elapsedMs: number) => { bucketMs: number; overflowed: boolean };
  waitForBucket: (
    startMs: number,
    elapsedMs: number,
    clock: { nowMs: () => number; sleep: (ms: number) => Promise<void> },
    jitterSource?: () => number,
  ) => Promise<{ bucketMs: number; overflowed: boolean }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const expectedBuckets = [
  100,
  1_000,
  10_000,
  60_000,
  120_000,
  180_000,
  240_000,
  300_000,
  600_000,
  1_200_000,
  2_400_000,
  4_800_000,
];

describe('finite-disclosure timing buckets', () => {
  it('keeps the TypeScript and container contracts synchronized', () => {
    expect(TIMING_BUCKETS_MS).toEqual(expectedBuckets);
    expect(containerDisclosure.TIMING_BUCKETS_MS).toEqual(expectedBuckets);
    expect(TIMING_BUCKET_BITS).toBe(4);
    expect(containerDisclosure.TIMING_BUCKET_BITS).toBe(4);
    expect(MAX_ENCLAVE_TIMEOUT_SECONDS).toBe(4_740);
    expect(containerDisclosure.MAX_ENCLAVE_TIMEOUT_SECONDS).toBe(4_740);
  });

  it('selects the smallest boundary and fails closed after the final bucket', () => {
    expect(resolveTimingBucket(100)).toEqual({ bucketMs: 100, overflowed: false });
    expect(resolveTimingBucket(101)).toEqual({ bucketMs: 1_000, overflowed: false });
    expect(resolveTimingBucket(300_001)).toEqual({ bucketMs: 600_000, overflowed: false });
    expect(resolveTimingBucket(2_400_001)).toEqual({
      bucketMs: 4_800_000,
      overflowed: false,
    });
    expect(resolveTimingBucket(4_800_001)).toEqual({
      bucketMs: 4_800_000,
      overflowed: true,
    });
  });

  it('allows one second of public scheduler wake-up delay', async () => {
    expect(TIMER_WAKE_TOLERANCE_MS).toBe(1_000);

    let nowMs = 20_000;
    const withinTolerance = await waitForBucket(
      0,
      nowMs,
      {
        nowMs: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms + TIMER_WAKE_TOLERANCE_MS;
        },
      },
      () => 0,
    );
    expect(withinTolerance).toEqual({ bucketMs: 60_000, overflowed: false });

    nowMs = 20_000;
    let sleepCount = 0;
    const beyondTolerance = await waitForBucket(
      0,
      nowMs,
      {
        nowMs: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms + (sleepCount++ === 0 ? TIMER_WAKE_TOLERANCE_MS + 1 : 0);
        },
      },
      () => 0,
    );
    expect(beyondTolerance).toEqual({ bucketMs: 120_000, overflowed: false });
  });

  it('adds bounded secret-independent response jitter after the bucket', async () => {
    expect(MAX_RESPONSE_JITTER_MS).toBe(1_000);

    let nowMs = 60_000;
    const result = await waitForBucket(
      0,
      nowMs,
      {
        nowMs: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
      () => MAX_RESPONSE_JITTER_MS,
    );

    expect(result).toEqual({ bucketMs: 60_000, overflowed: false });
    expect(nowMs).toBe(61_000);
  });
});
