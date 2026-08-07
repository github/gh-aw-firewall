'use strict';

const { TIMING_BUCKETS_MS } = require('./finite-disclosure');

/**
 * Response-timing bucketing.
 *
 * A query's actual completion latency is itself a secret-dependent signal
 * (a script that raises early on one branch and runs to completion on
 * another leaks information purely through wall-clock time, with no
 * dependence on the declared response schema at all). This module makes
 * every *launched* invocation's observable response time fall on one of a
 * small, fixed set of boundaries (`TIMING_BUCKETS_MS`), regardless of how
 * long the actual work took within that bucket.
 *
 * Design notes (see `docs/awf-config-spec.md` §14 for the full writeup):
 *
 *  - Time is measured with a monotonic clock (`process.hrtime.bigint()` by
 *    default, injectable for tests), never `Date.now()`, so system clock
 *    adjustments cannot shift a response across a bucket boundary.
 *  - `waitForBucket` resolves the bucket only after query execution, result
 *    validation, Docker removal, and host workspace teardown complete.
 *    Repository size and tree shape can affect cleanup latency, so cleanup
 *    must be included before choosing the charged timing bucket. Invocations
 *    remain serialized, preventing queued requests from observing an
 *    unaccounted cleanup delay from the preceding invocation.
 *  - If processing latency already exceeds the *last* bucket boundary
 *    (only possible if infrastructure overhead — not the script itself,
 *    whose timeout preserves a final-minute processing margin — pushes total
 *    processing past 10 minutes), the broker fails closed: it
 *    treats the invocation as a canonical error and responds immediately
 *    rather than waiting indefinitely for a nonexistent next boundary. This
 *    is a deliberately safe fail-closed fallback for a pathological
 *    infrastructure-latency edge case, not a normal code path.
 *  - A late host-scheduler wake after waiting for the final bucket does not
 *    turn an already completed invocation into an overflow. That delay occurs
 *    only after secret-dependent processing has finished and is attributable
 *    to public host scheduling; there is no later fixed bucket to pad to.
 */

/**
 * Public host-scheduler tolerance after a requested wake-up. Delays beyond
 * this bound are padded to the next fixed boundary instead of being returned
 * at a continuously varying late time.
 */
const TIMER_WAKE_TOLERANCE_MS = 5;

/** Resolves the smallest configured bucket at or after `elapsedMs`. */
function resolveTimingBucket(elapsedMs) {
  for (const bucketMs of TIMING_BUCKETS_MS) {
    if (elapsedMs <= bucketMs) return { bucketMs, overflowed: false };
  }
  return { bucketMs: TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1], overflowed: true };
}

/** Real monotonic clock. Milliseconds, sub-millisecond precision preserved as a float. */
function createRealClock() {
  return {
    nowMs: () => Number(process.hrtime.bigint()) / 1e6,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Waits (if necessary) until `startMs + bucket` on `clock`, where `bucket`
 * is the smallest configured boundary at or after `elapsedMs`.
 *
 * `elapsedMs` is measured by the caller as `clock.nowMs() - startMs` at the
 * moment all processing (including cleanup) completed. This function only
 * performs the remaining wait to the selected fixed boundary.
 *
 * @returns `{ bucketMs, overflowed }`. When `overflowed` is `true`, the
 *   caller must fail closed (canonical error) rather than waiting further.
 */
async function waitForBucket(startMs, elapsedMs, clock) {
  let observedElapsedMs = Math.max(elapsedMs, clock.nowMs() - startMs);

  while (true) {
    const { bucketMs, overflowed } = resolveTimingBucket(observedElapsedMs);
    if (overflowed) return { bucketMs, overflowed };

    const targetMs = startMs + bucketMs;
    const remainingMs = targetMs - clock.nowMs();
    if (remainingMs === 0) {
      return { bucketMs, overflowed: false };
    }
    if (remainingMs < 0) {
      observedElapsedMs = clock.nowMs() - startMs;
      continue;
    }

    await clock.sleep(remainingMs);
    const wakeMs = clock.nowMs();
    const isFinalBucket = bucketMs === TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1];
    if (wakeMs <= targetMs + TIMER_WAKE_TOLERANCE_MS || isFinalBucket) {
      return { bucketMs, overflowed: false };
    }

    observedElapsedMs = wakeMs - startMs;
  }
}

module.exports = {
  TIMING_BUCKETS_MS,
  TIMER_WAKE_TOLERANCE_MS,
  resolveTimingBucket,
  createRealClock,
  waitForBucket,
};
