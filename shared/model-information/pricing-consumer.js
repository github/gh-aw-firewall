'use strict';

const Ajv2020 = require('ajv/dist/2020');
const canonicalSchema = require('./schema.v1.json');
const consumerSchema = require('./pricing-consumer.v1.schema.json');
const { validate, validateRecords } = require('./contracts');
const { json, digest, readPricingPointer, readPricingSnapshotEnvelope } = require('./publication-contract.cjs');
const exact = require('./exact-pricing');

const schemaHash = digest(json({ canonicalSchema, consumerSchema }));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat('date-time', value => validate('model', {
  schemaVersion: 1,
  identity: { key: 'test/test', provider: 'test', rawId: 'test', lookupId: 'test' },
  lifecycle: { status: 'active' }, modelType: 'other',
  provenance: { authority: 'maintained', source: 'timestamp validation', at: value },
}).length === 0);
ajv.addSchema(canonicalSchema);
const check = ajv.compile(consumerSchema);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function reviewed(value, authority) {
  if (Array.isArray(value)) return value.forEach(item => reviewed(item, authority));
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'authority') && value.authority !== authority) {
    throw new Error('pricing_consumer_invalid_provenance');
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'price' && typeof item === 'string') exact.decimal(item);
    reviewed(item, authority);
  }
}

function readPricingSnapshot(bytes) {
  const snapshot = JSON.parse(bytes);
  if (!check(snapshot) || snapshot.schemaHash !== schemaHash) {
    throw new Error('pricing_consumer_unsupported_schema');
  }
  const { revision, ...payload } = snapshot;
  if (digest(json(payload)) !== revision) throw new Error('pricing_consumer_invalid_revision');
  const errors = validateRecords(snapshot.maintained.map(model => ({
    schemaVersion: 1, lifecycle: { status: 'active' }, modelType: 'other', ...model,
  })));
  if (errors.length) throw new Error(`pricing_consumer_invalid_records: ${errors.join('; ')}`);
  reviewed(snapshot.maintained, 'maintained');
  reviewed(snapshot.compatibility.sourceProvenance, 'maintained');
  for (const models of Object.values(snapshot.compatibility.providers)) {
    for (const rates of Object.values(models)) {
      for (const tier of [rates, rates.longContext].filter(Boolean)) {
        for (const field of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning']) {
          if (tier[field] != null) exact.decimal(tier[field]);
        }
      }
    }
  }
  for (const { prices } of snapshot.imported) {
    for (const [id, pricing] of Object.entries(prices)) {
      if (!id.startsWith(`${pricing.sourceNamespace}/`)) {
        throw new Error('pricing_consumer_invalid_import_scope');
      }
      reviewed(pricing, 'imported');
    }
  }
  return freeze(snapshot);
}

let bundled;
function getPricingSnapshot() {
  bundled ??= readPricingSnapshot(json(require('./pricing-consumer.v1.generated.json')));
  return bundled;
}

function readPublishedPricingSnapshot(snapshotBytes, pointerBytes, reviewedSourceBytes) {
  const pointer = readPricingPointer(pointerBytes);
  const envelope = readPricingSnapshotEnvelope(snapshotBytes);
  if (pointer.revision !== envelope.revision || pointer.sha256 !== digest(snapshotBytes) ||
      snapshotBytes.toString() !== reviewedSourceBytes.toString()) {
    throw new Error('pricing_consumer_publication_mismatch');
  }
  return freeze({ pointer, snapshot: readPricingSnapshot(snapshotBytes) });
}

module.exports = { getPricingSnapshot, readPricingSnapshot, readPublishedPricingSnapshot, schemaHash };
