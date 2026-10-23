#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  dataBranch, pointerPath, inputPaths, json, digest, payload, snapshotPath,
  isCommit, isDigest, readSnapshot, readPointer,
} = require('./publication-contract.cjs');

function publish({ cwd, bytes, expectedDigest, sourceCommit }) {
  if (!isDigest(expectedDigest) || digest(bytes) !== expectedDigest) {
    throw new Error('Artifact digest differs from validated read-only job output');
  }
  const candidate = readSnapshot(bytes);
  if (!isCommit(sourceCommit) || candidate.sourceCommit !== sourceCommit) {
    throw new Error('Artifact source differs from trusted event SHA');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-publish-'));
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
    return execFileSync('git', ['cat-file', 'blob', match[1]], { cwd, env });
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
      if (git('log', '-1', '--format=%H', `${sourceCommit}..${main}`, '--', ...inputPaths)) {
        return 'superseded: newer publication inputs on main';
      }
      // ls-remote failure is not an absent branch (and must never bootstrap one).
      const remote = git('ls-remote', '--heads', 'origin', `refs/heads/${dataBranch}`);
      let parent = null;
      if (remote) {
        git('fetch', '--no-tags', 'origin', `refs/heads/${dataBranch}`);
        parent = git('rev-parse', 'FETCH_HEAD');
      }
      const currentBytes = blob(parent, pointerPath);
      if (parent && !currentBytes) throw new Error('Existing data branch has no usable v1 pointer');
      if (currentBytes) {
        const current = readPointer(currentBytes);
        const currentSnapshotBytes = blob(parent, current.snapshot);
        if (!currentSnapshotBytes || digest(currentSnapshotBytes) !== current.sha256) {
          throw new Error('Existing current snapshot is missing or corrupt');
        }
        const currentSnapshot = readSnapshot(currentSnapshotBytes);
        if (currentSnapshot.revision !== current.revision ||
            !ancestor(currentSnapshot.sourceCommit, current.sourceCommit) ||
            !ancestor(current.sourceCommit, main)) throw new Error('Invalid current source provenance');
        if (current.sourceCommit !== sourceCommit && ancestor(sourceCommit, current.sourceCommit)) {
          return 'superseded: current pointer has a newer source';
        }
        if (!ancestor(current.sourceCommit, sourceCommit)) throw new Error('Divergent publication sources');
        if (current.sourceCommit === sourceCommit && current.revision !== candidate.revision) {
          throw new Error('One source commit produced different catalogue revisions');
        }
        if (current.revision === candidate.revision) return 'unchanged';
      }
      const file = snapshotPath(candidate.revision);
      const existing = blob(parent, file);
      let snapshotBytes = bytes;
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
      if (parent) git('read-tree', parent);
      else git('read-tree', '--empty');
      if (!existing) add(file, snapshotBytes);
      add(pointerPath, json({
        schemaVersion: 1, revision: candidate.revision, sourceCommit,
        snapshot: file, sha256: digest(snapshotBytes),
      }));
      const tree = git('write-tree');
      const commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []),
        '-m', `chore: publish model catalogue ${candidate.revision}`);
      const pushed = spawnSync('git', ['push', 'origin', `${commit}:refs/heads/${dataBranch}`],
        { cwd, env, encoding: 'utf8' });
      if (pushed.status === 0) return `published ${candidate.revision}`;
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
      process.argv.length !== 3) throw new Error('Publisher requires trusted repository main push');
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (origin !== 'https://github.com/github/gh-aw-firewall' &&
      origin !== 'https://github.com/github/gh-aw-firewall.git') throw new Error('Untrusted publication origin');
  console.log(publish({
    cwd: process.cwd(), bytes: fs.readFileSync(process.argv[2]),
    expectedDigest: process.env.SNAPSHOT_SHA256, sourceCommit: process.env.GITHUB_SHA,
  }));
}
module.exports = { publish };
