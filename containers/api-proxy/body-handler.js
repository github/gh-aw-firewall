'use strict';

/**
 * AWF API Proxy — Body-handler factory and shared retry sleep abstraction.
 *
 * Request collection receives error-handling and tracing dependencies here to
 * avoid a circular dependency on proxy-request.js. Transformation order lives
 * in request-body-pipeline.js; notice selection lives in steering-injection.js.
 */

const { createBodyCollector } = require('./body-collection');
const { transformRequestBody } = require('./request-body-pipeline');

// ── Sleep abstraction (overridable in tests to avoid real setTimeout delays) ──

/** Resolves after `ms` milliseconds (overridable in tests via module-level setter). */
let _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thin indirection used by proxy-request.js so that replacing `_sleep` via
 * `_setSleepForTests` is reflected in all callers without them needing to
 * re-import the variable.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => _sleep(ms);

/** @internal Test-only: replace the sleep implementation so retries are instant. */
function _setSleepForTests(fn) { _sleep = fn; }
/** @internal Test-only: restore the real sleep implementation. */
function _resetSleepForTests() { _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Create the body-handler functions with injected dependencies.
 *
 * @param {{ handleRequestError: Function, otel: object }} deps
 * @returns {{ collectRequestBody: Function, transformRequestBody: Function }}
 */
function createBodyHandler({ handleRequestError, otel }) {
  return {
    collectRequestBody: createBodyCollector({ handleRequestError, otel }),
    transformRequestBody,
  };
}

module.exports = { createBodyHandler, sleep, _setSleepForTests, _resetSleepForTests };
