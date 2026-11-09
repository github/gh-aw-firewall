#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  dataBranch, channelPath, inputPaths, json, digest, payload, snapshotPath,
  isCommit, isDigest, readSnapshot, readPointer,
} = require('./publication-contract.cjs');

function publish({ cwd, bytes, expectedDigest, sourceCommit, bytesV2, expectedDigestV2 }) {
  const inputs = [{ bytes, expectedDigest }];
  if (bytesV2 !== undefined) inputs.push({ bytes: bytesV2, expectedDigest: expectedDigestV2 });
  const publications = inputs.map(input => {
    if (!isDigest(input.expectedDigest) || digest(input.bytes) !== input.expectedDigest) {
      throw new Error('Artifact digest differs from validated read-only job output');
    }
    const candidate = readSnapshot(input.bytes);
    if (!isCommit(sourceCommit) || candidate.sourceCommit !== sourceCommit) {
      throw new Error('Artifact source differs from trusted event SHA');
    }
    return { candidate, bytes: input.bytes };
  });
  if (publications.length === 2 &&
      publications.map(({ candidate }) => candidate.schemaVersion).join() !== '1,2') {
    throw new Error('Dual publication requires v1 and v2 artifacts');
  }
  const temporary = fs.mkdtempSync(path.join(cwd, '.awf-catalogue-publish-'));
  const env = {
    ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const ancestor = (older, newer) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd, env });
    if (result.status !== 0 && result.status !== 1) throw new Error('Unable to establish source ancestry');
    return result.status === 0;
  };
  const blob = (parent, file) => {
    if (!parent) return null;
    const entry = git('ls-tree', parent, '--', file);
    if (!entry) return null;
    const match = /^100644 blob ([a-f0-9]{40})\t/.exec(entry);
    if (!match) throw new Error(`Expected ordinary immutable file: ${file}`);
    return execFileSync('git', ['cat-file', 'blob', match[1]], { cwd, env, maxBuffer: Infinity });
  };
  const add = (file, content) => {
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, env, input: content, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${hash},${file}`);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      git('fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main');
      const main = git('rev-parse', 'refs/remotes/origin/main');
      if (!ancestor(sourceCommit, main)) throw new Error('Publication source is not on trusted main');
      if (git('log', '--show-pulls', '-1', '--format=%H', `${sourceCommit}..${main}`, '--', ...inputPaths)) {
        return 'superseded: newer publication inputs on main';
      }
      // ls-remote failure is not an absent branch (and must never bootstrap one).
      const remote = git('ls-remote', '--heads', 'origin', `refs/heads/${dataBranch}`);
      let parent = null;
      if (remote) {
        git('fetch', '--no-tags', 'origin', `refs/heads/${dataBranch}`);
        parent = git('rev-parse', 'FETCH_HEAD');
      }
      const updates = [];
      for (const { candidate, bytes: candidateBytes } of publications) {
        const version = candidate.schemaVersion;
        const pointerPath = channelPath(version);
        const channelBytes = blob(parent, pointerPath);
        // Bootstrap v2 only from a usable existing v1 channel, retaining all v1 bytes.
        const currentBytes = channelBytes || (version === 2 ? blob(parent, channelPath(1)) : null);
        if (parent && !currentBytes) throw new Error('Existing data branch has no usable v1 pointer');
        if (currentBytes) {
          const current = readPointer(currentBytes, channelBytes ? version : 1);
          const currentSnapshotBytes = blob(parent, current.snapshot);
          if (!currentSnapshotBytes || digest(currentSnapshotBytes) !== current.sha256) {
            throw new Error('Existing current snapshot is missing or corrupt');
          }
          const currentSnapshot = readSnapshot(currentSnapshotBytes);
          if (currentSnapshot.schemaVersion !== current.schemaVersion ||
              currentSnapshot.revision !== current.revision ||
              !ancestor(currentSnapshot.sourceCommit, current.sourceCommit) ||
              !ancestor(current.sourceCommit, main)) throw new Error('Invalid current source provenance');
          if (current.sourceCommit !== sourceCommit && ancestor(sourceCommit, current.sourceCommit)) {
            return 'superseded: current pointer has a newer source';
          }
          if (!ancestor(current.sourceCommit, sourceCommit)) throw new Error('Divergent publication sources');
          if (channelBytes && current.sourceCommit === sourceCommit && current.revision !== candidate.revision) {
            throw new Error('One source commit produced different catalogue revisions');
          }
          if (channelBytes && current.revision === candidate.revision) continue;
        }
        const file = snapshotPath(candidate.revision, version);
        const existing = blob(parent, file);
        let snapshotBytes = candidateBytes;
        if (existing) {
          const snapshot = readSnapshot(existing);
          if (snapshot.revision !== candidate.revision ||
              json(payload(snapshot)) !== json(payload(candidate)) ||
              !ancestor(snapshot.sourceCommit, sourceCommit)) {
            throw new Error('Immutable revision collision');
          }
          // A reviewed rollback can reuse earlier immutable bytes, never overwrite them.
          snapshotBytes = existing;
        }
        updates.push({ file, existing, snapshotBytes, pointerPath, pointer: json({
          schemaVersion: version, revision: candidate.revision, sourceCommit,
          snapshot: file, sha256: digest(snapshotBytes),
        }) });
      }
      if (!updates.length) return 'unchanged';
      if (parent) git('read-tree', parent);
      else git('read-tree', '--empty');
      for (const update of updates) {
        if (!update.existing) add(update.file, update.snapshotBytes);
        add(update.pointerPath, update.pointer);
      }
      const tree = git('write-tree');
      const revisions = publications.map(({ candidate }) => candidate.revision).join(' ');
      const commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []),
        '-m', `chore: publish model catalogue ${revisions}`);
      const pushed = spawnSync('git', ['push', 'origin', `${commit}:refs/heads/${dataBranch}`],
        { cwd, env, encoding: 'utf8' });
      if (pushed.status === 0) return `published ${revisions}`;
      // A competing normal push may have won. Refetch/recheck ancestry and immutable
      // bytes; a persistent transport/permission error fails without altering current.
      if (attempt === 2) throw new Error(`Data branch push failed: ${pushed.stderr}`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.env.GITHUB_EVENT_NAME !== 'push' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== 'github/gh-aw-firewall' ||
      ![3, 4].includes(process.argv.length)) throw new Error('Publisher requires trusted repository main push');
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (origin !== 'https://github.com/github/gh-aw-firewall' &&
      origin !== 'https://github.com/github/gh-aw-firewall.git') throw new Error('Untrusted publication origin');
  console.log(publish({
    cwd: process.cwd(), bytes: fs.readFileSync(process.argv[2]),
    expectedDigest: process.env.SNAPSHOT_SHA256, sourceCommit: process.env.GITHUB_SHA,
    bytesV2: process.argv[3] ? fs.readFileSync(process.argv[3]) : undefined,
    expectedDigestV2: process.env.SNAPSHOT_SHA256_V2,
  }));
}
module.exports = { publish };
