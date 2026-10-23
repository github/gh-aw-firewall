#!/usr/bin/env node
'use strict';

const Ajv2020 = require('ajv/dist/2020');
const { validate, validateRecords } = require('./contracts');
const canonicalSchema = require('./schema.v1.json');
const publicationSchema = require('./publication.v1.schema.json');
const { json, digest, payload, isCommit, readSnapshot } = require('./publication-contract.cjs');

function observationTime(models) {
  if (!models.length) throw new Error('Publication has no reviewed pricing or harness facts');
  const observations = [];
  function evidence(value) {
    if (Array.isArray(value)) return value.forEach(evidence);
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'authority')) {
      if (value.authority !== 'maintained' || !value.revision || !value.at || !value.confidence) {
        throw new Error('Published facts require dated reviewed maintained evidence');
      }
      observations.push(new Date(value.at).toISOString());
    }
    Object.values(value).forEach(evidence);
  }
  evidence(models);
  return observations.sort().at(-1);
}

function buildSnapshot(catalogue, sourceCommit, sourceTime) {
  if (!isCommit(sourceCommit)) throw new Error('Expected exact source commit');
  const errors = validate('resolvedExport', catalogue);
  if (errors.length) throw new Error(errors.join('; '));
  const models = catalogue.models.filter(model => model.provenance.authority === 'maintained')
    .filter(model => model.tariffs?.length || model.harnesses?.length)
    .map(model => ({
      identity: Object.fromEntries(['key', 'provider', 'rawId', 'lookupId']
        .map(key => [key, model.identity[key]])),
      provenance: model.provenance,
      ...(model.tariffs?.length ? { tariffs: model.tariffs } : {}),
      ...(model.harnesses?.length ? { harnesses: model.harnesses } : {}),
    })).sort((a, b) => a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
  for (const model of models) {
    if ((model.harnesses || []).some(harness => harness.scope.provider !== model.identity.provider)) {
      throw new Error(`Cross-provider harness: ${model.identity.key}`);
    }
  }
  const snapshot = {
    schemaVersion: 1,
    schemaHash: digest(json({ canonicalSchema, publicationSchema })),
    sourceCommit,
    publishedAt: new Date(sourceTime).toISOString(),
    observedAt: observationTime(models),
    effectiveFrom: new Date(sourceTime).toISOString(),
    provenance: { authority: 'central_feed', source: 'https://github.com/github/gh-aw-firewall' },
    models,
  };
  snapshot.revision = digest(json(payload(snapshot)));
  snapshot.sha256 = snapshot.revision;
  const bytes = json(snapshot);
  validateSnapshot(bytes);
  return bytes;
}

const schemaHash = digest(json({ canonicalSchema, publicationSchema }));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat('date-time', value => validate('model', {
  schemaVersion: 1,
  identity: { key: 'test/test', provider: 'test', rawId: 'test', lookupId: 'test' },
  lifecycle: { status: 'active' }, modelType: 'other',
  provenance: { authority: 'maintained', source: 'timestamp validation', at: value },
}).length === 0);
ajv.addSchema(canonicalSchema);
const check = ajv.compile(publicationSchema);

function validateSnapshot(bytes) {
  const snapshot = readSnapshot(bytes);
  if (snapshot.schemaHash !== schemaHash || !check(snapshot)) {
    throw new Error('Unsupported publication schema or invalid snapshot');
  }
  const errors = validateRecords(snapshot.models.map(model => ({
    schemaVersion: 1, lifecycle: { status: 'active' }, modelType: 'other', ...model,
  })));
  if (errors.length) throw new Error(errors.join('; '));
  if (observationTime(snapshot.models) !== snapshot.observedAt) {
    throw new Error('Publication observedAt must match committed evidence');
  }
  return snapshot;
}

module.exports = { buildSnapshot, validateSnapshot, schemaHash };
