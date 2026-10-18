'use strict';

/**
 * Parsing for the optional `x-awf-caller` request header.
 *
 * The header is a caller declaration from inside the sandbox, not an
 * authenticated identity. It is attribution metadata only: it must never
 * change routing, model policy, steering, guards, budget accounting or cost,
 * and it is kept separate from the trusted `req.awfRequestContext`.
 */

const CALLER_HEADER = 'x-awf-caller';
const MAX_CALLER_LENGTH = 128;
const CALLER_PATTERN = /^(?:main|subagent\/[A-Za-z0-9_.:/-]+)$/;
const SUBAGENT_PREFIX = 'subagent/';

/**
 * Why a header value is rejected, or null when it is valid or absent.
 * The reason is a fixed token; the rejected value itself is never returned.
 *
 * @param {unknown} value
 * @returns {'not_a_string'|'too_long'|'invalid_format'|null}
 */
function callerHeaderRejection(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'not_a_string';
  if (value.length > MAX_CALLER_LENGTH) return 'too_long';
  if (!CALLER_PATTERN.test(value)) return 'invalid_format';
  return null;
}

/**
 * Parse an `x-awf-caller` header value.
 *
 * @param {unknown} value
 * @returns {Readonly<{ purpose: 'agent'|'subagent', agent_name?: string, caller_source: 'caller_header' }>|null}
 *   The parsed caller, or null when the header is absent or invalid.
 */
function parseCallerHeader(value) {
  if (value === undefined || callerHeaderRejection(value) !== null) return null;
  if (value === 'main') {
    return Object.freeze({ purpose: 'agent', caller_source: 'caller_header' });
  }
  return Object.freeze({
    purpose: 'subagent',
    agent_name: value.slice(SUBAGENT_PREFIX.length),
    caller_source: 'caller_header',
  });
}

/**
 * Record fields that attribute a request. A trusted AWF purpose always wins
 * over a caller declaration; with neither, no fields are returned.
 *
 * @param {string|undefined} awfPurpose - `req.awfRequestContext?.purpose`
 * @param {object|null|undefined} caller - `req.awfCaller`
 * @returns {{ purpose?: string, agent_name?: string, caller_source?: string }}
 */
function callerRecordFields(awfPurpose, caller) {
  if (awfPurpose) return { purpose: awfPurpose, caller_source: 'awf' };
  if (!caller || caller.caller_source !== 'caller_header') return {};
  if (caller.purpose === 'agent') return { purpose: 'agent', caller_source: 'caller_header' };
  if (caller.purpose === 'subagent' && typeof caller.agent_name === 'string' && caller.agent_name) {
    return { purpose: 'subagent', agent_name: caller.agent_name, caller_source: 'caller_header' };
  }
  return {};
}

module.exports = {
  CALLER_HEADER,
  MAX_CALLER_LENGTH,
  callerHeaderRejection,
  parseCallerHeader,
  callerRecordFields,
};
