import * as path from 'path';
import {
  AGENT_PROTOCOL_VERSION,
  ALLOWED_REQUEST_KEYS,
  CANONICAL_ERROR_JSON,
  FORBIDDEN_REQUEST_KEYS,
  MAX_PRIVATE_REPO_LENGTH,
  MAX_RESULT_BYTES,
  MAX_SCHEMA_BYTES,
  MAX_TASK_BYTES,
  RESULT_STATUS_BIT_COST,
  TIMING_BUCKETS_MS,
  TIMING_BUCKET_BITS,
  canonicalOkJson,
  canonicalizeSchemaValue,
  parseAndValidateQueryOutput,
  queryBitsForSchema,
  schemaCardinality,
  strictParseJson,
  validateSchema,
  validateValueAgainstSchema,
  validateBoundedAgentRequest,
  type BoundedAgentSchemaNode,
} from './protocol';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const brokerFraming = require(path.join(brokerDir, 'framing.js'));
const brokerProtocol = require(path.join(brokerDir, 'protocol.js'));
const brokerSpec = require(path.join(brokerDir, 'enclave-runner-spec.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const booleanSchema: BoundedAgentSchemaNode = { type: 'boolean' };

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  privateRepo: 'octo/alpha',
  schema: booleanSchema,
  task: 'Does this repository declare a SECURITY.md?',
  ...overrides,
});

/**
 * Request-protocol coverage.
 *
 * A bounded-agent request may select only a configured repository, declare a
 * finite result schema, and carry bounded task text. Everything else — image,
 * command, executable, mount, environment, endpoint, network, proxy,
 * credential, timeout, resource limit, runtime, tool definition — and any
 * unknown key must be rejected.
 */
describe('validateBoundedAgentRequest', () => {
  it('accepts the only permitted request shape', () => {
    const result = validateBoundedAgentRequest(request());
    expect(result.valid).toBe(true);
  });

  it('exposes exactly three allowed keys', () => {
    expect([...ALLOWED_REQUEST_KEYS].sort()).toEqual(['privateRepo', 'schema', 'task']);
  });

  it.each(FORBIDDEN_REQUEST_KEYS)('rejects the forbidden control "%s"', (key) => {
    const result = validateBoundedAgentRequest(request({ [key]: 'anything' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join('\n')).toContain(`request may not specify "${key}"`);
    }
  });

  it('names every capability class the design forbids', () => {
    for (const key of [
      'image', 'command', 'executable', 'mounts', 'env', 'endpoint', 'network', 'proxy',
      'credentials', 'timeout', 'resources', 'runtime', 'tools', 'model', 'profile', 'systemPrompt',
    ]) {
      expect(FORBIDDEN_REQUEST_KEYS).toContain(key);
    }
  });

  it('rejects unknown keys', () => {
    const result = validateBoundedAgentRequest(request({ somethingNew: 1 }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join('\n')).toContain('unknown request key: "somethingNew"');
    }
  });

  it('rejects non-object requests', () => {
    for (const raw of [undefined, null, 'x', 42, []]) {
      expect(validateBoundedAgentRequest(raw).valid).toBe(false);
    }
  });

  it('rejects repository selectors that are not a bare owner/repo slug', () => {
    for (const privateRepo of [
      'https://github.com/octo/alpha',
      'octo/alpha/../secret',
      '../octo/alpha',
      'octo',
      42,
    ]) {
      expect(validateBoundedAgentRequest(request({ privateRepo })).valid).toBe(false);
    }
    expect(
      validateBoundedAgentRequest(request({ privateRepo: `a/${'b'.repeat(MAX_PRIVATE_REPO_LENGTH)}` })).valid,
    ).toBe(false);
  });

  it('rejects a non-finite result schema', () => {
    for (const schema of [
      { type: 'string' },
      { type: 'number' },
      { $ref: '#/definitions/self' },
      { type: 'object', fields: { a: { type: 'string' } } },
      { type: 'integer' },
    ]) {
      expect(validateBoundedAgentRequest(request({ schema })).valid).toBe(false);
    }
  });

  it('byte-bounds the task text against the configured and hard limits', () => {
    expect(validateBoundedAgentRequest(request({ task: '' })).valid).toBe(false);
    expect(validateBoundedAgentRequest(request({ task: 42 })).valid).toBe(false);
    expect(
      validateBoundedAgentRequest(request({ task: 'x'.repeat(100) }), { maxTaskBytes: 50 }).valid,
    ).toBe(false);
    expect(
      validateBoundedAgentRequest(request({ task: 'x'.repeat(50) }), { maxTaskBytes: 50 }).valid,
    ).toBe(true);
    expect(
      validateBoundedAgentRequest(request({ task: 'x'.repeat(MAX_TASK_BYTES + 1) }), {
        maxTaskBytes: MAX_TASK_BYTES * 10,
      }).valid,
    ).toBe(false);
  });

  it('counts task size in UTF-8 bytes, not code units', () => {
    // "€" is 3 bytes.
    expect(validateBoundedAgentRequest(request({ task: '€€' }), { maxTaskBytes: 5 }).valid).toBe(false);
    expect(validateBoundedAgentRequest(request({ task: '€€' }), { maxTaskBytes: 6 }).valid).toBe(true);
  });
});

describe('canonical envelopes and timing buckets (PR1 primitives)', () => {
  it('re-exports the complete finite-disclosure boundary', () => {
    expect(MAX_RESULT_BYTES).toBeGreaterThan(0);
    expect(MAX_SCHEMA_BYTES).toBeGreaterThan(0);
    expect(MAX_PRIVATE_REPO_LENGTH).toBeGreaterThan(0);
    expect(schemaCardinality({ type: 'boolean' })).toBe(2n);
    expect(strictParseJson('true')).toEqual({ value: true });
    expect(validateSchema(booleanSchema).valid).toBe(true);
    expect(validateValueAgainstSchema(booleanSchema, true)).toBe(true);
    expect(canonicalizeSchemaValue(booleanSchema, true)).toBe('true');
  });

  it('uses the shared canonical error shape', () => {
    expect(CANONICAL_ERROR_JSON).toBe('{"status":"error"}');
  });

  it('uses the shared canonical success shape', () => {
    expect(canonicalOkJson('true')).toBe('{"status":"ok","result":true}');
  });

  it('uses the shared fixed timing buckets', () => {
    expect(TIMING_BUCKETS_MS).toEqual([10, 100, 1_000, 10_000, 60_000, 600_000]);
    expect(TIMING_BUCKET_BITS).toBe(3);
  });

  it('charges the status and timing channels in addition to the schema payload', () => {
    // boolean => 1 payload bit
    expect(queryBitsForSchema(booleanSchema)).toBe(RESULT_STATUS_BIT_COST + 1 + TIMING_BUCKET_BITS);
    // const => 0 payload bits, still charged for status + timing
    expect(queryBitsForSchema({ type: 'const', value: 'x' })).toBe(
      RESULT_STATUS_BIT_COST + TIMING_BUCKET_BITS,
    );
  });

  it('validates and canonicalizes enclave output against the declared schema', () => {
    expect(parseAndValidateQueryOutput('true', booleanSchema)).toEqual({ ok: true, canonical: 'true' });
    expect(parseAndValidateQueryOutput('"true"', booleanSchema).ok).toBe(false);
    expect(parseAndValidateQueryOutput('', booleanSchema).ok).toBe(false);
    expect(parseAndValidateQueryOutput('true true', booleanSchema).ok).toBe(false);
  });
});

/**
 * The broker runs in its own container image and cannot import AWF's
 * TypeScript sources. These checks fail the moment the two implementations of
 * the bounded-agent request contract disagree.
 */
describe('TypeScript ↔ broker parity', () => {
  it('shares the PR1 canonical envelopes and buckets', () => {
    expect(brokerProtocol.CANONICAL_ERROR_JSON).toBe(CANONICAL_ERROR_JSON);
    expect(brokerProtocol.TIMING_BUCKETS_MS).toEqual([...TIMING_BUCKETS_MS]);
    expect(brokerProtocol.canonicalOkJson('true')).toBe(canonicalOkJson('true'));
  });

  it('agrees on the framing protocol version', () => {
    expect(brokerFraming.AGENT_PROTOCOL_VERSION).toBe(String(AGENT_PROTOCOL_VERSION));
  });

  it('agrees on the allowed and forbidden request keys', () => {
    expect([...brokerFraming.ALLOWED_REQUEST_KEYS].sort()).toEqual([...ALLOWED_REQUEST_KEYS].sort());
    expect([...brokerFraming.FORBIDDEN_REQUEST_KEYS].sort()).toEqual([...FORBIDDEN_REQUEST_KEYS].sort());
  });

  it('agrees on accept/reject for a shared vector table', () => {
    const vectors: Array<Record<string, unknown> | unknown> = [
      request(),
      request({ task: '' }),
      request({ privateRepo: 'octo' }),
      request({ schema: { type: 'string' } }),
      request({ image: 'evil' }),
      request({ tools: [] }),
      request({ nope: true }),
      'not an object',
      null,
    ];
    for (const vector of vectors) {
      const ts = validateBoundedAgentRequest(vector, { maxTaskBytes: 4096 });
      const broker = brokerFraming.validateBoundedAgentRequest(vector, { maxTaskBytes: 4096 });
      expect(broker.valid).toBe(ts.valid);
    }
  });

  it('agrees on the schema information charge for a shared vector table', () => {
    const schemas: BoundedAgentSchemaNode[] = [
      { type: 'boolean' },
      { type: 'const', value: 1 },
      { type: 'enum', values: ['a', 'b', 'c'] },
      { type: 'integer', minimum: 0, maximum: 255 },
      { type: 'object', fields: [
        { name: 'a', schema: { type: 'boolean' } },
        { name: 'b', schema: { type: 'boolean' } },
      ] },
    ];
    for (const schema of schemas) {
      expect(brokerProtocol.queryBitsForSchema(schema)).toBe(queryBitsForSchema(schema));
    }
  });
});

describe('broker request framing', () => {
  const headers = {
    'x-awf-agent-version': '1',
    'x-awf-repo': 'octo/alpha',
    'x-awf-schema-b64': Buffer.from(JSON.stringify(booleanSchema), 'utf8').toString('base64url'),
  };
  const rawHeaders = Object.entries(headers).flat();

  it('assembles the canonical request from fixed headers plus the task body', () => {
    const framed = brokerFraming.buildRequestFromFrame(headers, rawHeaders, 'task text');
    expect(framed.error).toBeUndefined();
    expect(framed.request).toEqual({
      privateRepo: 'octo/alpha',
      schema: booleanSchema,
      task: 'task text',
    });
  });

  it('rejects any other x-awf control header', () => {
    const extra = { ...headers, 'x-awf-runtime': 'runc' };
    const framed = brokerFraming.buildRequestFromFrame(
      extra,
      Object.entries(extra).flat(),
      'task',
    );
    expect(framed.error).toMatch(/unsupported request control header/);
  });

  it('rejects duplicated control headers', () => {
    const duplicated = [...rawHeaders, 'x-awf-repo', 'octo/beta'];
    const framed = brokerFraming.buildRequestFromFrame(headers, duplicated, 'task');
    expect(framed.error).toMatch(/duplicate request header/);
  });

  it('rejects an unsupported protocol version', () => {
    const bad = { ...headers, 'x-awf-agent-version': '2' };
    expect(
      brokerFraming.buildRequestFromFrame(bad, Object.entries(bad).flat(), 'task').error,
    ).toMatch(/protocol version/);
  });

  it('rejects a malformed schema header', () => {
    const bad = { ...headers, 'x-awf-schema-b64': 'not+base64url/' };
    expect(
      brokerFraming.buildRequestFromFrame(bad, Object.entries(bad).flat(), 'task').error,
    ).toMatch(/schema header/);
  });
});

describe('enclave runner spec identifiers', () => {
  it('uses a bounded-agent-specific run label distinct from bounded queries', () => {
    expect(brokerSpec.RUN_LABEL).toBe('awf.bounded-agent.run');
    expect(brokerSpec.INVOCATION_LABEL).toBe('awf.bounded-agent.invocation');
  });
});
