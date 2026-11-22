'use strict';

/** Mirrors the timing contract in src/bounded-execution/finite-disclosure.ts. */

const { ceilLog2 } = require('./cardinality');

const TIMING_BUCKETS_MS = [
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
const FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS = 60_000;
const MAX_ENCLAVE_TIMEOUT_SECONDS =
  (TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] - FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS) / 1000;
const TIMING_BUCKET_BITS = ceilLog2(TIMING_BUCKETS_MS.length);

module.exports = {
  TIMING_BUCKETS_MS,
  FINAL_TIMING_BUCKET_PROCESSING_MARGIN_MS,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  TIMING_BUCKET_BITS,
};
