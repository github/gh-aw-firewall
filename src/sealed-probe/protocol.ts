/**
 * Sealed-probe request/result protocol: validation and canonicalization.
 *
 * This module defines the wire protocol for sealed probes independently of
 * any broker or sandbox runtime (neither of which exist yet — this is the
 * configuration/protocol foundation only, see docs/awf-config-spec.md §14).
 *
 * Protocol summary:
 *   - A **request** asks the (future) broker to run a script against a
 *     private repository and report which of exactly three declared
 *     `outcomes` occurred.
 *   - A **result** is the script's report, expressed as the closed JSON
 *     object `{"result": "<one of the declared outcomes>"}`.
 *   - `"ERROR"` is a reserved sentinel: it can never be one of the three
 *     declared outcomes, and every parsing/validation failure canonicalizes
 *     to `{"result":"ERROR"}` rather than throwing or passing through
 *     untrusted data.
 *
 * Result parsing deliberately does NOT use a general-purpose JSON Schema
 * validator. The accepted result shape is a single fixed, closed schema (one
 * required key, string enum value), so it is parsed with a small
 * hand-written, linear-time (no backtracking) grammar below. This avoids
 * pulling arbitrary/attacker-influenced JSON Schema documents into an
 * execution path.
 */

/** Number of outcomes a sealed-probe request must declare. */
export const OUTCOME_COUNT = 3;

/** Reserved outcome value. Cannot be used as a declared outcome. */
export const RESERVED_ERROR_OUTCOME = 'ERROR';

/** Maximum size, in UTF-8 bytes, of a single outcome string. */
export const MAX_OUTCOME_BYTES = 64;

/** Safe enum identifier accepted by every transport and canonical serializer. */
export const OUTCOME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Maximum size, in UTF-8 bytes, of a probe script. */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** Maximum size, in UTF-8 bytes, of a serialized sealed-probe request. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** Maximum size, in UTF-8 bytes, of the probe result file. */
export const MAX_RESULT_BYTES = 1024;

/** Maximum length of a `privateRepo` "owner/repo" slug. */
export const MAX_PRIVATE_REPO_LENGTH = 140;

/**
 * Matches a bare `owner/repo` slug only: no scheme/host (`://`), no path
 * traversal (`..`), no query string or fragment (`?`/`#`), no wildcard
 * (`*`), and no extra path segments (only one `/` is allowed).
 *
 * Keep in sync with `sealedProbes.privateRepos.items.pattern` in
 * `docs/awf-config.schema.json` (JSON Schema cannot share a regex constant
 * with TypeScript source).
 */
export const SEALED_PROBE_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/;

/** A sealed-probe request's declared outcomes: exactly three distinct strings. */
export type SealedProbeOutcomes = readonly [string, string, string];

/** A sealed-probe execution request. */
export interface SealedProbeRequest {
  /** Private repository (`owner/repo`) the probe script runs against. */
  privateRepo: string;
  /** Exactly three distinct, non-reserved outcome labels the script may report. */
  outcomes: SealedProbeOutcomes;
  /** The probe script source. */
  script: string;
}

/** A sealed-probe result: always exactly one of the declared outcomes, or the reserved `"ERROR"` sentinel. */
export interface SealedProbeResult {
  result: string;
}

export type SealedProbeValidation =
  | { valid: true }
  | { valid: false; errors: string[] };

/**
 * The exact closed-schema representation of a valid result object for a
 * given set of declared outcomes.
 *
 * This is a plain data representation for documentation/introspection use
 * by future broker code — it is never executed against a JSON Schema
 * engine here. Actual enforcement is done by {@link parseSealedProbeResult}.
 */
export interface SealedProbeResultSchema {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly ['result'];
  readonly properties: {
    readonly result: {
      readonly type: 'string';
      readonly enum: readonly string[];
    };
  };
}

/** Builds the closed-schema representation of a valid result for the given outcomes. */
export function buildSealedProbeResultSchema(outcomes: SealedProbeOutcomes): SealedProbeResultSchema {
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

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates a single declared outcome label.
 * Returns an error message, or `undefined` when valid.
 */
export function validateOutcome(outcome: unknown): string | undefined {
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

/**
 * Validates a full `outcomes` value: must be an array of exactly
 * {@link OUTCOME_COUNT} unique, individually-valid outcome labels.
 * Returns an array of human-readable errors (empty = valid).
 */
export function validateOutcomes(outcomes: unknown): string[] {
  if (!Array.isArray(outcomes)) {
    return [`outcomes must be an array of exactly ${OUTCOME_COUNT} strings`];
  }

  const errors: string[] = [];
  if (outcomes.length !== OUTCOME_COUNT) {
    errors.push(`outcomes must contain exactly ${OUTCOME_COUNT} entries`);
  }

  outcomes.forEach((outcome, index) => {
    const error = validateOutcome(outcome);
    if (error) errors.push(`outcomes[${index}]: ${error}`);
  });

  const stringOutcomes = outcomes.filter((o): o is string => typeof o === 'string');
  if (new Set(stringOutcomes).size !== stringOutcomes.length) {
    errors.push('outcomes must be unique');
  }

  return errors;
}

/**
 * Validates an unknown value as a {@link SealedProbeRequest}.
 * Enforces field shape, the `privateRepo` slug pattern, outcome rules, and
 * script/request size caps.
 */
export function validateSealedProbeRequest(request: unknown): SealedProbeValidation {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { valid: false, errors: ['request must be a JSON object'] };
  }

  const errors: string[] = [];
  const requestRecord = request as Record<string, unknown>;
  const { privateRepo, outcomes, script } = requestRecord;
  const allowedKeys = new Set(['privateRepo', 'outcomes', 'script']);
  for (const key of Object.keys(requestRecord)) {
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

  let serialized: string | undefined;
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

/** Produces the canonical JSON representation of a sealed-probe result. */
export function canonicalizeSealedProbeResult(result: string): string {
  const canonical: SealedProbeResult = { result };
  return JSON.stringify(canonical);
}

/** The canonical JSON text for the reserved error result: `{"result":"ERROR"}`. */
export const CANONICAL_ERROR_RESULT_JSON = canonicalizeSealedProbeResult(RESERVED_ERROR_OUTCOME);

const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipJsonWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text[i])) i++;
  return i;
}

/**
 * Parses a JSON string literal starting at `text[start]` (`text[start]` must
 * be `"`). Handles standard JSON escapes. Returns `undefined` for anything
 * that is not a well-formed, terminated JSON string (including raw control
 * characters, which JSON requires to be escaped).
 */
function parseJsonStringLiteral(
  text: string,
  start: number,
): { value: string; endIndex: number } | undefined {
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
          return undefined; // invalid escape sequence
      }
    }

    // Raw control characters are not permitted inside a JSON string literal.
    if (ch.charCodeAt(0) < 0x20) return undefined;

    value += ch;
    i++;
  }

  return undefined; // unterminated string
}

/**
 * Strictly parses `raw` against the exact closed grammar
 * `{"result": <JSON string>}` — nothing more, nothing less.
 *
 * Rejects (returns `undefined` for): malformed JSON, any leading/trailing
 * content beyond the single object, duplicate `"result"` keys (the grammar
 * only permits one `key: value` pair, so a second key is trailing data),
 * extra fields, and non-string values.
 */
function tryExtractStrictResultValue(raw: string): string | undefined {
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

  if (i !== raw.length) return undefined; // trailing data

  return parsed.value;
}

/**
 * Parses a probe's raw stdout/result text into a {@link SealedProbeResult}.
 *
 * Always succeeds: malformed JSON, duplicate keys, trailing data, extra
 * fields, or a value outside the declared `outcomes` enum all canonicalize
 * to `{ result: "ERROR" }` rather than throwing.
 */
export function parseSealedProbeResult(raw: string, outcomes: SealedProbeOutcomes): SealedProbeResult {
  if (utf8ByteLength(raw) > MAX_RESULT_BYTES) {
    return { result: RESERVED_ERROR_OUTCOME };
  }
  const value = tryExtractStrictResultValue(raw);
  if (
    value !== undefined
    && (
      value === RESERVED_ERROR_OUTCOME
      || (outcomes as readonly string[]).includes(value)
    )
  ) {
    return { result: value };
  }
  return { result: RESERVED_ERROR_OUTCOME };
}

/**
 * Parses a probe's raw result text and returns its canonical JSON
 * representation directly (equivalent to
 * `canonicalizeSealedProbeResult(parseSealedProbeResult(raw, outcomes).result)`).
 */
export function parseSealedProbeResultJson(raw: string, outcomes: SealedProbeOutcomes): string {
  return canonicalizeSealedProbeResult(parseSealedProbeResult(raw, outcomes).result);
}
