/* global require, module, Buffer, process */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const FILES = ['agent-proof.txt', 'agent-version.txt', 'response.txt'];
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;

function assertDirectoryChain(directory) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Evidence source directory or ancestor is not a real directory');
    }
  }
}

function redact(contents, secrets) {
  let result = contents;
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) {
    result = result.replaceAll(secret, '[REDACTED]').replaceAll('Bearer ' + secret, '[REDACTED]');
  }
  return result;
}

function collectAgentRegressionEvidence(sourceDirectory, destination, secrets = []) {
  const target = path.resolve(destination);
  assertDirectoryChain(path.dirname(target));
  fs.mkdirSync(target, { mode: 0o700 });
  assertDirectoryChain(sourceDirectory);
  const source = path.resolve(sourceDirectory);
  const root = fs.lstatSync(source);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Evidence source is not a real directory');
  }

  let total = 0;
  const copied = [];
  for (const name of FILES) {
    const sourcePath = path.join(source, name);
    let fd;
    try {
      const before = fs.lstatSync(sourcePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) continue;
      fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size > MAX_FILE_BYTES || total + opened.size > MAX_TOTAL_BYTES) continue;
      const contents = redact(fs.readFileSync(fd, 'utf8'), secrets);
      const targetPath = path.join(target, name);
      fs.writeFileSync(targetPath, contents, { mode: 0o600, flag: 'wx' });
      total += Buffer.byteLength(contents);
      copied.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return copied;
}

module.exports = { collectAgentRegressionEvidence, assertDirectoryChain, redact, FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };

if (process.env.AWF_COLLECT_AGENT_REGRESSION_EVIDENCE === '1') {
  const [sourceDirectory, destination] = process.argv.slice(1);
  if (!sourceDirectory || !destination) throw new Error('Evidence source and destination are required');
  collectAgentRegressionEvidence(sourceDirectory, destination, [
    process.env.COPILOT_GITHUB_TOKEN,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ]);
}
