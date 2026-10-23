#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSnapshot } = require('../../shared/model-information/publication.cjs');
const { digest } = require('./publication-contract.cjs');

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
