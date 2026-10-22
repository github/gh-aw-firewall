#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { allowed, buildReport, loadCaptures, json } = require('./maintain.cjs');

const reportFile = 'shared/model-information/maintenance-report.json';
const maxBytes = 16 * 1024 * 1024;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', ...args], {
  cwd, encoding: 'utf8', maxBuffer: maxBytes, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
});
const filesAt = (cwd, revision) => git(cwd, 'ls-tree', '-rz', '--full-tree', revision).split('\0')
  .filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, separator).split(' ');
    return { mode, type, file: entry.slice(separator + 1) };
  });

function verifyProposal(cwd, artifact, evidence, options) {
  const { baseRevision, reviewBaseRevision, captureSha256, selectedNumber } = options;
  if (typeof captureSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(captureSha256)) {
    throw new Error('Missing trusted capture manifest digest from the capture job');
  }
  if (![baseRevision, reviewBaseRevision].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))) {
    throw new Error('Missing trusted maintenance base revisions');
  }
  if (!Number.isSafeInteger(selectedNumber) || selectedNumber < 0) throw new Error('Invalid trusted PR selection');
  loadCaptures(evidence, captureSha256);
  const output = JSON.parse(fs.readFileSync(path.join(artifact, 'agent_output.json'), 'utf8'));
  if (!Array.isArray(output.items)) throw new Error('Missing safe-output items');
  const writes = output.items.filter(item => ['create_pull_request', 'push_to_pull_request_branch'].includes(item.type));
  if (writes.length > 1 || (writes.length &&
      writes[0].type !== (selectedNumber ? 'push_to_pull_request_branch' : 'create_pull_request'))) {
    throw new Error('Proposal does not match the trusted create/update selection');
  }
  const transports = fs.readdirSync(artifact).filter(file => /^aw-.*\.(bundle|patch)$/.test(file));
  const bundles = transports.filter(file => file.endsWith('.bundle'));
  const patches = transports.filter(file => file.endsWith('.patch'));
  if (bundles.length !== writes.length || patches.length > bundles.length ||
      patches.some(file => !bundles.includes(file.replace(/\.patch$/, '.bundle')))) {
    throw new Error('Expected exactly one bundle for a model update, or none for a no-op');
  }
  let head = baseRevision;
  if (bundles.length) {
    const bundle = path.join(artifact, bundles[0]);
    const info = fs.lstatSync(bundle);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Invalid or oversized proposal bundle');
    const heads = git(cwd, 'bundle', 'list-heads', bundle).trim().split('\n');
    if (heads.length !== 1 || !/^[0-9a-f]{40} /.test(heads[0])) throw new Error('Ambiguous proposal bundle head');
    head = heads[0].split(' ')[0];
    git(cwd, 'fetch', '--no-tags', bundle, head);
    git(cwd, 'merge-base', '--is-ancestor', baseRevision, head);
    const commits = git(cwd, 'rev-list', `${baseRevision}..${head}`).trim().split('\n').filter(Boolean);
    if (!commits.length) throw new Error('Update bundle contains no new commits');
    for (const commit of commits) {
      const changed = git(cwd, 'diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only', '-z', commit)
        .split('\0').filter(Boolean);
      for (const file of changed) if (!allowed(file)) throw new Error(`Out-of-scope bundled change: ${file}`);
      for (const entry of filesAt(cwd, commit).filter(entry => allowed(entry.file))) {
        if (entry.mode !== '100644' || entry.type !== 'blob') throw new Error(`Non-regular model data: ${entry.file}`);
      }
    }
  }
  const data = filesAt(cwd, head).filter(entry => allowed(entry.file));
  for (const entry of data) {
    if (entry.mode !== '100644' || entry.type !== 'blob') throw new Error(`Non-regular model data: ${entry.file}`);
  }
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-proposal-'));
  let added = false;
  try {
    git(cwd, 'worktree', 'add', '--detach', candidate, head);
    added = true;
    fs.writeFileSync(path.join(evidence, 'base-revision'), baseRevision);
    fs.writeFileSync(path.join(evidence, 'review-base-revision'), reviewBaseRevision);
    const report = data.some(entry => entry.file === reportFile)
      ? JSON.parse(git(cwd, 'show', `${head}:${reportFile}`)) : null;
    fs.writeFileSync(path.join(evidence, 'proposal.json'), json({
      changes: report ? report.changes.map(change => change.proposal).filter(claim => claim.file) : [],
    }));
    const expected = buildReport(candidate, evidence, captureSha256, { baseRevision, reviewBaseRevision });
    if (Boolean(expected) !== Boolean(writes.length) || (expected && json(expected) !== json(report))) {
      throw new Error('Missing or stale maintenance impact report for the published bundle');
    }
    if (!expected) return { head, changed: false };
    // Overlay only verified JSON data; scripts, tests, schemas and npm/Jest configuration stay trusted.
    const names = new Set(data.map(entry => entry.file));
    for (const entry of filesAt(cwd, 'HEAD').filter(entry => allowed(entry.file) && !names.has(entry.file))) {
      fs.unlinkSync(path.join(cwd, entry.file));
    }
    for (const { file } of data) {
      const destination = path.join(cwd, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, git(cwd, 'show', `${head}:${file}`));
    }
    return { head, changed: Boolean(expected) };
  } finally {
    if (added) git(cwd, 'worktree', 'remove', '--force', candidate);
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [artifact, evidence] = process.argv.slice(2);
  try {
    const result = verifyProposal(path.resolve(__dirname, '../..'), artifact, evidence, {
      baseRevision: process.env.AWF_MODEL_BASE_REVISION,
      reviewBaseRevision: process.env.AWF_MODEL_REVIEW_BASE_REVISION,
      captureSha256: process.env.AWF_MODEL_CAPTURE_SHA256,
      selectedNumber: Number(process.env.AWF_MODEL_SELECTED_PR),
    });
    console.log(json(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyProposal };
