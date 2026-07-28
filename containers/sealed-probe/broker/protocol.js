'use strict';

/**
 * Sealed-probe request/result protocol — broker-side implementation.
 *
 * This is a deliberate, behaviour-identical mirror of `src/sealed-probe/
 * protocol.ts`. The broker runs inside its own container image and cannot
 * import AWF's TypeScript sources, so the rules are restated here and pinned
 * by `src/sealed-probe/protocol-parity.test.ts`, which runs the *same* vector
 * table through both implementations and fails if they ever diverge.
 *
 * Do not "improve" one side without the other.
 */

const OUTCOME_COUNT = 3;
const RESERVED_ERROR_OUTCOME = 'ERROR';
const MAX_OUTCOME_BYTES = 64;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024;
const MAX_PRIVATE_REPO_LENGTH = 140;

const SEALED_PROBE_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;
const OUTCOME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function utf8ByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Builds the closed result schema the broker enforces for a request. */
function buildSealedProbeResultSchema(outcomes) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['result'],
    properties: {
      result: {
        type: 'string',
        enum: [...outcomes, RESERVED_ERROR_OUTCOME],
      },
    },
  };
}

function validateOutcome(outcome) {
  if (typeof outcome !== 'string') return 'outcome must be a string';
  if (outcome.length === 0) return 'outcome must not be empty';
  if (outcome === RESERVED_ERROR_OUTCOME) {
    return `outcome must not use the reserved value "${RESERVED_ERROR_OUTCOME}"`;
  }
  if (hasControlCharacters(outcome)) return 'outcome must not contain control characters';
  if (utf8ByteLength(outcome) > MAX_OUTCOME_BYTES) {
    return `outcome must be at most ${MAX_OUTCOME_BYTES} UTF-8 bytes`;
  }
  if (!OUTCOME_PATTERN.test(outcome)) {
    return 'outcome must be an ASCII identifier starting with a letter and containing only letters, digits, "_" or "-"';
  }
  return undefined;
}

function validateOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) {
    return [`outcomes must be an array of exactly ${OUTCOME_COUNT} strings`];
  }

  const errors = [];
  if (outcomes.length !== OUTCOME_COUNT) {
    errors.push(`outcomes must contain exactly ${OUTCOME_COUNT} entries`);
  }

  outcomes.forEach((outcome, index) => {
    const error = validateOutcome(outcome);
    if (error) errors.push(`outcomes[${index}]: ${error}`);
  });

  const stringOutcomes = outcomes.filter((o) => typeof o === 'string');
  if (new Set(stringOutcomes).size !== stringOutcomes.length) {
    errors.push('outcomes must be unique');
  }

  return errors;
}

function validateSealedProbeRequest(request) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const errors = [];
  const { privateRepo, outcomes, script } = request;
  const allowedKeys = new Set(['privateRepo', 'outcomes', 'script']);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) {
      errors.push(`request.${key} is not supported`);
    }
  }

  if (typeof privateRepo !== 'string' || privateRepo.length === 0) {
    errors.push('privateRepo must be a non-empty string');
  } else if (
    privateRepo.length > MAX_PRIVATE_REPO_LENGTH
    || !SEALED_PROBE_REPO_PATTERN.test(privateRepo)
  ) {
    errors.push(
      'privateRepo must be an "owner/repo" slug (no scheme, host, path traversal, query, fragment, or wildcard)',
    );
  }

  errors.push(...validateOutcomes(outcomes));

  if (typeof script !== 'string' || script.length === 0) {
    errors.push('script must be a non-empty string');
  } else if (utf8ByteLength(script) > MAX_SCRIPT_BYTES) {
    errors.push(`script must be at most ${MAX_SCRIPT_BYTES} bytes`);
  }

  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    errors.push('request must be JSON-serializable');
  }
  if (serialized !== undefined && utf8ByteLength(serialized) > MAX_REQUEST_BYTES) {
    errors.push(`request must be at most ${MAX_REQUEST_BYTES} bytes`);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

function canonicalizeSealedProbeResult(result) {
  return JSON.stringify({ result });
}

const CANONICAL_ERROR_RESULT_JSON = canonicalizeSealedProbeResult(RESERVED_ERROR_OUTCOME);

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipJsonWhitespace(text, index) {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text[i])) i++;
  return i;
}

function parseJsonStringLiteral(text, start) {
  if (text[start] !== '"') return undefined;

  let i = start + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      return { value, endIndex: i + 1 };
    }

    if (ch === '\\') {
      const escape = text[i + 1];
      switch (escape) {
        case '"': value += '"'; i += 2; continue;
        case '\\': value += '\\'; i += 2; continue;
        case '/': value += '/'; i += 2; continue;
        case 'b': value += '\b'; i += 2; continue;
        case 'f': value += '\f'; i += 2; continue;
        case 'n': value += '\n'; i += 2; continue;
        case 'r': value += '\r'; i += 2; continue;
        case 't': value += '\t'; i += 2; continue;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default:
          return undefined;
      }
    }

    if (ch.charCodeAt(0) < 0x20) return undefined;

    value += ch;
    i++;
  }

  return undefined;
}

function tryExtractStrictResultValue(raw) {
  let i = skipJsonWhitespace(raw, 0);

  if (raw[i] !== '{') return undefined;
  i++;
  i = skipJsonWhitespace(raw, i);

  if (raw.slice(i, i + 8) !== '"result"') return undefined;
  i += 8;
  i = skipJsonWhitespace(raw, i);

  if (raw[i] !== ':') return undefined;
  i++;
  i = skipJsonWhitespace(raw, i);

  const parsed = parseJsonStringLiteral(raw, i);
  if (!parsed) return undefined;
  i = skipJsonWhitespace(raw, parsed.endIndex);

  if (raw[i] !== '}') return undefined;
  i++;
  i = skipJsonWhitespace(raw, i);

  if (i !== raw.length) return undefined;

  return parsed.value;
}

function parseSealedProbeResult(raw, outcomes) {
  if (utf8ByteLength(raw) > MAX_RESULT_BYTES) {
    return { result: RESERVED_ERROR_OUTCOME };
  }
  const value = tryExtractStrictResultValue(raw);
  if (
    value !== undefined
    && (value === RESERVED_ERROR_OUTCOME || outcomes.includes(value))
  ) {
    return { result: value };
  }
  return { result: RESERVED_ERROR_OUTCOME };
}

function parseSealedProbeResultJson(raw, outcomes) {
  return canonicalizeSealedProbeResult(parseSealedProbeResult(raw, outcomes).result);
}

module.exports = {
  OUTCOME_COUNT,
  RESERVED_ERROR_OUTCOME,
  MAX_OUTCOME_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  MAX_PRIVATE_REPO_LENGTH,
  SEALED_PROBE_REPO_PATTERN,
  CANONICAL_ERROR_RESULT_JSON,
  buildSealedProbeResultSchema,
  validateOutcome,
  validateOutcomes,
  validateSealedProbeRequest,
  canonicalizeSealedProbeResult,
  parseSealedProbeResult,
  parseSealedProbeResultJson,
};
