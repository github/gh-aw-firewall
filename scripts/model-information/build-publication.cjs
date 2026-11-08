#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSnapshot } = require('../../shared/model-information/publication.cjs');
const { buildSnapshot: buildSnapshotV2 } = require('../../shared/model-information/publication.v2.cjs');
const { digest } = require('./publication-contract.cjs');

function build(output, outputV2) {
  const root = path.resolve(__dirname, '../..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  if (sourceCommit !== process.env.GITHUB_SHA) throw new Error('Checkout must equal trusted event source SHA');
  execFileSync(process.execPath, [path.join(__dirname, 'compile.cjs'), '--check'], { cwd: root, stdio: 'inherit' });
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'shared/model-information/catalog.generated.json')));
  const bytes = buildSnapshot(catalogue, sourceCommit, git('show', '-s', '--format=%cI', sourceCommit));
  fs.writeFileSync(output, bytes, { flag: 'wx' });
  if (outputV2) {
    const bytesV2 = buildSnapshotV2(catalogue, sourceCommit, git('show', '-s', '--format=%cI', sourceCommit));
    fs.writeFileSync(outputV2, bytesV2, { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256_v2=${digest(bytesV2)}\n`);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${digest(bytes)}\n`);
}

if (require.main === module) {
  if (![3, 4].includes(process.argv.length)) throw new Error('Usage: build-publication.cjs OUTPUT_V1 [OUTPUT_V2]');
  build(process.argv[2], process.argv[3]);
}
module.exports = { buildSnapshot, buildSnapshotV2 };
