'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { identity } = require('./identity');
const { validate } = require('./contracts');

const IMPORTER_VERSION = '2';
const metadata = require('./imported/legacy-models-dev.metadata.json');
// Retain the original exported names for callers of the pinned import API.
const BUNDLED_GIT_BLOB = metadata.revision;
const BUNDLED_SHA256 = metadata.sha256;
const BUNDLED_COMMIT_TIMESTAMP = metadata.retrievedAt;
const METADATA_FIELDS = ['source', 'revision', 'retrievedAt', 'sha256', 'license'];
const COMPONENTS = {
  prompt: 'input',
  completion: 'output',
  input_cache_read: 'cachedInput',
  input_cache_write: 'cacheWrite',
};

// The bundled "models.dev" file is an OpenRouter-shaped {data: []} snapshot:
// prices are USD per token, not USD per million tokens.
function perMillion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new Error('Invalid per-token price');
  }
  const [integer, fraction = ''] = value.split('.');
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, '');
  const places = fraction.length - 6;
  if (places <= 0) return `${digits}${'0'.repeat(-places)}`.replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(places + 1, '0');
  return `${padded.slice(0, -places)}.${padded.slice(-places)}`.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Normalize a pinned copy of containers/api-proxy/models.dev.catalog.json.
 * For an arbitrary source, metadata.retrievedAt MUST be independently known by
 * the caller. For the bundled source, the schema-required retrievedAt is the
 * Git commit time explicitly identified as repository capture in source;
 * the upstream retrieval time is unknown.
 * revision identifies the pinned source (for the bundled file, use its Git blob ID);
 * sha256 is the SHA-256 of the exact input bytes, checked before parsing.
 * This function neither fetches upstream data nor changes runtime matching.
 */
function importLegacySnapshot(bytes, metadata) {
  if (!Buffer.isBuffer(bytes) || !metadata || typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some(key => !METADATA_FIELDS.includes(key)) ||
      METADATA_FIELDS.some(key => typeof metadata[key] !== 'string' || !metadata[key].trim())) {
    throw new Error('Invalid legacy snapshot metadata or input bytes');
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (metadata.sha256 !== actualHash) throw new Error('Legacy snapshot SHA-256 mismatch');
  const emptySnapshot = {
    schemaVersion: 1, ...metadata, importerVersion: IMPORTER_VERSION,
    accepted: 0, rejected: 0, collisions: [], models: [],
  };
  const errors = validate('importedSnapshot', emptySnapshot);
  if (errors.length) throw new Error(`Invalid legacy snapshot metadata: ${errors.join('; ')}`);

  let source;
  try {
    source = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid legacy snapshot JSON');
  }
  if (!source || Array.isArray(source) ||
      Object.keys(source).some(key => !['data', 'total_count', 'links'].includes(key)) ||
      !Array.isArray(source.data)) {
    throw new Error('Expected legacy snapshot {data: []}');
  }
  if ((source.total_count !== undefined &&
       (!Number.isSafeInteger(source.total_count) || source.total_count !== source.data.length)) ||
      (source.links !== undefined &&
       (!source.links || typeof source.links !== 'object' || Array.isArray(source.links) ||
        source.links.next !== null))) {
    throw new Error('Incomplete catalogue coverage: total_count mismatch or unfetched next page');
  }
  const provenance = {
    authority: 'imported', source: metadata.source, revision: metadata.revision,
    at: metadata.retrievedAt, confidence: 'imported', freshness: 'unknown',
  };
  const groups = new Map();
  let rejected = 0;
  for (const entry of source.data) {
    try {
      if (!entry || typeof entry.id !== 'string' ||
          !/^[a-z0-9][a-z0-9-]*\/.+$/.test(entry.id)) throw new Error('Invalid model ID');
      const slash = entry.id.indexOf('/');
      const modelIdentity = identity(entry.id.slice(0, slash), entry.id.slice(slash + 1));
      if (!entry.pricing || typeof entry.pricing !== 'object' || Array.isArray(entry.pricing)) {
        throw new Error('Missing pricing');
      }
      const components = {};
      for (const [legacy, canonical] of Object.entries(COMPONENTS)) {
        if (entry.pricing[legacy] !== undefined && entry.pricing[legacy] !== null) {
          components[canonical] = { price: perMillion(entry.pricing[legacy]), provenance };
        }
      }
      if (!components.input || !components.output) throw new Error('Missing token prices');
      // Both lifecycle and modelType are required by the shared schema. "active"
      // means listed in this legacy snapshot only; "other" avoids asserting a
      // provider execution type. Neither establishes live availability.
      const record = {
        schemaVersion: 1, identity: modelIdentity,
        lifecycle: { status: 'active' }, modelType: 'other',
        importedPricing: {
          sourceNamespace: modelIdentity.provider,
          currency: 'USD', unit: 'USD_PER_1M_TOKENS', components, provenance,
        },
        provenance,
      };
      if (validate('model', record).length) throw new Error('Invalid normalized model');
      const key = `${modelIdentity.provider}/${modelIdentity.lookupId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    } catch {
      rejected++;
    }
  }
  const collisions = [];
  const models = [];
  for (const [key, group] of groups) {
    if (group.length > 1) {
      collisions.push(`${key}: ${group.map(model => model.identity.key).join(', ')}`);
      rejected += group.length;
    } else models.push(group[0]);
  }
  models.sort((a, b) => a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
  collisions.sort();
  const result = { ...emptySnapshot, accepted: models.length, rejected, collisions, models };
  const resultErrors = validate('importedSnapshot', result);
  if (resultErrors.length) throw new Error(`Invalid imported snapshot: ${resultErrors.join('; ')}`);
  return result;
}

function importPinnedLegacySnapshot() {
  const bytes = readFileSync(join(__dirname, '../../containers/api-proxy/models.dev.catalog.json'));
  return importLegacySnapshot(bytes, metadata);
}

module.exports = {
  importLegacySnapshot, importPinnedLegacySnapshot, IMPORTER_VERSION,
  BUNDLED_GIT_BLOB, BUNDLED_SHA256, BUNDLED_COMMIT_TIMESTAMP,
};
