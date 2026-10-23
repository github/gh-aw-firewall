'use strict';

const crypto = require('node:crypto');

const dataBranch = 'catalogue-data';
const pointerPath = 'channels/v1/current.json';
// Keep the workflow filter and the out-of-order source check identical.
const inputPaths = [
  'shared/model-information/**',
  'scripts/model-information/**',
  'containers/api-proxy/models.dev.catalog.json',
  'containers/api-proxy/model-information.*.generated.json',
  'containers/api-proxy/ai-credits-pricing-reference.json',
  'containers/api-proxy/model-api-mapping.json',
  'containers/api-proxy/catalogue-*.js',
  'containers/api-proxy/package.json',
  'containers/api-proxy/package-lock.json',
  'src/model-information.compat.generated.json',
  'docs/model-api-mapping.json',
  '.github/workflows/publish-model-catalogue.yml',
  'package.json',
  'package-lock.json',
  '.npmrc',
];
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
const json = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const payload = snapshot => ({
  schemaVersion: snapshot.schemaVersion, schemaHash: snapshot.schemaHash, models: snapshot.models,
});
const snapshotPath = revision => `snapshots/v1/${revision}.json`;
const isCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Dependency-free envelope checks for the write job. Full schema/semantic validation
// happens in the read-only producer; its exact artifact digest crosses the job boundary.
function readSnapshot(bytes) {
  const snapshot = JSON.parse(bytes);
  const fields = ['schemaVersion', 'schemaHash', 'revision', 'sha256', 'sourceCommit',
    'publishedAt', 'observedAt', 'effectiveFrom', 'provenance', 'models'];
  if (Object.keys(snapshot).sort().join() !== fields.sort().join() ||
      snapshot.schemaVersion !== 1 || !isDigest(snapshot.schemaHash) ||
      !isDigest(snapshot.revision) || !isCommit(snapshot.sourceCommit) ||
      !Array.isArray(snapshot.models) ||
      snapshot.sha256 !== snapshot.revision ||
      digest(json(payload(snapshot))) !== snapshot.revision ||
      json(snapshot) !== bytes.toString()) {
    throw new Error('Invalid publication snapshot envelope, canonical bytes or payload digest');
  }
  return snapshot;
}

function readPointer(bytes) {
  const pointer = JSON.parse(bytes);
  if (Object.keys(pointer).sort().join() !==
      ['schemaVersion', 'revision', 'sourceCommit', 'snapshot', 'sha256'].sort().join() ||
      pointer.schemaVersion !== 1 || !isDigest(pointer.revision) ||
      !isDigest(pointer.sha256) || !isCommit(pointer.sourceCommit) ||
      pointer.snapshot !== snapshotPath(pointer.revision) || json(pointer) !== bytes.toString()) {
    throw new Error('Invalid current pointer');
  }
  return pointer;
}

module.exports = {
  dataBranch, pointerPath, inputPaths, json, digest, payload, snapshotPath,
  isCommit, isDigest, readSnapshot, readPointer,
};
