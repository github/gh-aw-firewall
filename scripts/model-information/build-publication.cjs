#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Ajv2020 = require('ajv/dist/2020');
const { validate, validateRecords } = require('../../shared/model-information/contracts');
const canonicalSchema = require('../../shared/model-information/schema.v1.json');
const publicationSchema = require('../../shared/model-information/publication.v1.schema.json');
const { json, digest, payload, isCommit, readSnapshot } = require('./publication-contract.cjs');

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
  // Do not turn a broken or accidentally empty projection into a usable feed.
  if (!models.length) throw new Error('Publication has no reviewed pricing or harness facts');
  const snapshot = {
    schemaVersion: 1,
    schemaHash: digest(json({ canonicalSchema, publicationSchema })),
    sourceCommit,
    publishedAt: new Date(sourceTime).toISOString(),
    observedAt: observations.sort().at(-1),
    effectiveFrom: new Date(sourceTime).toISOString(),
    provenance: { authority: 'central_feed', source: 'https://github.com/github/gh-aw-firewall' },
    models,
  };
  snapshot.revision = digest(json(payload(snapshot)));
  snapshot.sha256 = snapshot.revision;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  ajv.addFormat('date-time', value => validate('model', {
    schemaVersion: 1,
    identity: { key: 'test/test', provider: 'test', rawId: 'test', lookupId: 'test' },
    lifecycle: { status: 'active' }, modelType: 'other',
    provenance: { authority: 'maintained', source: 'timestamp validation', at: value },
  }).length === 0);
  ajv.addSchema(canonicalSchema);
  const check = ajv.compile(publicationSchema);
  if (!check(snapshot)) throw new Error(ajv.errorsText(check.errors));
  const semanticErrors = validateRecords(models.map(model => ({
    schemaVersion: 1, lifecycle: { status: 'active' }, modelType: 'other', ...model,
  })));
  if (semanticErrors.length) throw new Error(semanticErrors.join('; '));
  const bytes = json(snapshot);
  readSnapshot(bytes);
  return bytes;
}

function build(output) {
  const root = path.resolve(__dirname, '../..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  if (sourceCommit !== process.env.GITHUB_SHA) throw new Error('Checkout must equal trusted event source SHA');
  execFileSync(process.execPath, [path.join(__dirname, 'compile.cjs'), '--check'], { cwd: root, stdio: 'inherit' });
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'shared/model-information/catalog.generated.json')));
  const bytes = buildSnapshot(catalogue, sourceCommit, git('show', '-s', '--format=%cI', sourceCommit));
  fs.writeFileSync(output, bytes, { flag: 'wx' });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${digest(bytes)}\n`);
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: build-publication.cjs OUTPUT');
  build(process.argv[2]);
}
module.exports = { buildSnapshot };
