import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BOUNDED_QUERY_SEED_MAP_VERSION,
  CANONICAL_ERROR_JSON,
  PRIVATE_REPOSITORY_SEED_MAP_VERSION,
  canonicalOkJson,
  informationChargeForSchema,
  queryBitsForSchema,
  serializePrivateRepositorySeedMap,
  validateFiniteSchema,
  validateSchema,
  type BoundedQuerySeedMap,
  type PrivateRepositorySeedMap,
} from './index';
import * as boundedQueryProtocol from '../bounded-query/protocol';
import * as boundedQueryTypes from '../bounded-query/types';

/* eslint-disable @typescript-eslint/no-require-imports */
const sharedRuntime = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'bounded-execution'),
);
const queryProtocol = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker', 'protocol.js'),
);
const queryLedger = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker', 'ledger.js'),
);
const queryScheduler = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker', 'scheduler.js'),
);
const queryAudit = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker', 'audit.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-execution compatibility foundation', () => {
  it('keeps TypeScript bounded-query exports on the shared implementations', () => {
    expect(boundedQueryProtocol.validateSchema).toBe(validateSchema);
    expect(boundedQueryProtocol.canonicalOkJson).toBe(canonicalOkJson);
    expect(boundedQueryTypes.BOUNDED_QUERY_SEED_MAP_VERSION).toBe(BOUNDED_QUERY_SEED_MAP_VERSION);
  });

  it('preserves schema acceptance, rejection, canonical bytes, and information charges', () => {
    const accepted = { type: 'object', fields: { z: { type: 'boolean' }, a: { type: 'boolean' } } };
    const rejected = { type: 'object', fields: {} };
    const validation = validateFiniteSchema(accepted);
    expect(validation).toEqual(validateSchema(accepted));
    expect(validateFiniteSchema(rejected)).toEqual(validateSchema(rejected));
    if (!validation.valid) throw new Error('expected accepted schema');

    expect(informationChargeForSchema(validation.schema)).toBe(queryBitsForSchema(validation.schema));
    expect(canonicalOkJson('{"a":false,"z":true}')).toBe(
      '{"status":"ok","result":{"a":false,"z":true}}',
    );
    expect(CANONICAL_ERROR_JSON).toBe('{"status":"error"}');
  });

  it('keeps broker compatibility modules identical to the shared runtime', () => {
    expect(queryProtocol.validateSchema).toBe(sharedRuntime.validateSchema);
    expect(queryProtocol.canonicalOkJson('"ok"')).toBe(sharedRuntime.canonicalSuccessJson('"ok"'));
    expect(queryLedger.createLedger).toBe(sharedRuntime.createSensitivityLedger);
    expect(queryScheduler.resolveTimingBucket).toBe(sharedRuntime.resolveTimingBucket);
    expect(queryAudit.createAuditLog).toBe(sharedRuntime.createProtectedAuditLog);
  });

  it('preserves ledger debit decisions and fixed timing bucket choice', () => {
    const seeds = new Map([['octo/private', { seedId: 'a'.repeat(32), sensitivity: 'confidential' }]]);
    const legacy = queryLedger.createLedger(seeds);
    const shared = sharedRuntime.createSensitivityLedger(seeds);

    for (const charge of [4, 4, 1]) {
      expect(shared.tryDebit('octo/private', charge)).toBe(legacy.tryDebit('octo/private', charge));
      expect(shared.remainingBits('octo/private')).toBe(legacy.remainingBits('octo/private'));
    }
    for (const elapsed of [0, 10, 11, 100, 60_001, 600_001]) {
      expect(sharedRuntime.resolveTimingBucket(elapsed)).toEqual(queryScheduler.resolveTimingBucket(elapsed));
    }
  });

  it('preserves protected audit detail bounding and canonical record shape', () => {
    const detail = `secret-${'x'.repeat(sharedRuntime.MAX_REASON_LENGTH + 20)}`;
    expect(sharedRuntime.redactAuditDetail(detail)).toBe(detail.slice(0, sharedRuntime.MAX_REASON_LENGTH));

    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-execution-audit-'));
    try {
      const audit = sharedRuntime.createProtectedAuditLog(auditDir);
      audit.failure('invocation-1', 'query-error', detail);
      const record = JSON.parse(
        fs.readFileSync(path.join(auditDir, 'bounded-query.jsonl'), 'utf8').trim(),
      );
      expect(record).toMatchObject({
        kind: 'failure',
        invocationId: 'invocation-1',
        reason: 'query-error',
        detail: detail.slice(0, sharedRuntime.MAX_REASON_LENGTH),
      });
      expect(Object.keys(record).sort()).toEqual(
        ['ts', 'kind', 'invocationId', 'reason', 'detail'].sort(),
      );
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('keeps private repository staging descriptors and serialized bytes unchanged', () => {
    expect(PRIVATE_REPOSITORY_SEED_MAP_VERSION).toBe(BOUNDED_QUERY_SEED_MAP_VERSION);
    const shared: PrivateRepositorySeedMap = {
      version: PRIVATE_REPOSITORY_SEED_MAP_VERSION,
      runId: 'f'.repeat(32),
      seeds: [{ repo: 'octo/private', seedId: 'a'.repeat(32), sensitivity: 'internal' }],
    };
    const legacy: BoundedQuerySeedMap = shared;

    const expected = JSON.stringify(legacy, null, 2) + '\n';
    expect(serializePrivateRepositorySeedMap(shared)).toBe(expected);

    const parsed = sharedRuntime.parsePrivateRepositorySeedMap(
      expected,
      sharedRuntime.SENSITIVITY_RUN_BITS,
    );
    expect(parsed).toEqual({
      runId: shared.runId,
      seeds: new Map([
        ['octo/private', { seedId: 'a'.repeat(32), sensitivity: 'internal' }],
      ]),
    });
  });
});
