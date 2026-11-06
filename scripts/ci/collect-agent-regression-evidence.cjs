/* global require, module, Buffer, process */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
/* eslint-enable @typescript-eslint/no-require-imports */

const FILES = ['agent-proof.txt', 'agent-version.txt', 'response.txt'];
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_ROUTING_BYTES = 1024 * 1024;
const MAX_ROUTING_RECORDS = 100;
const MAX_HOST_LOG_BYTES = 16 * 1024 * 1024;
const COMPLETION_MARKER = 'AWF-REGRESSION-COMPLETE';

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

function readBoundedFile(filename, limit) {
  assertDirectoryChain(path.dirname(filename));
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Rejected evidence file');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > limit) throw new Error('Rejected evidence file');
    return buffer.subarray(0, length);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function checkExactFile(filename, marker) {
  try {
    const contents = readBoundedFile(filename, MAX_FILE_BYTES).toString('utf8');
    return contents.replace(/\n+$/, '') === marker ? 'match' : 'mismatch';
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'rejected';
  }
}

function collectMarkerCheck(hostLog, destination, marker) {
  const report = {
    proof: checkExactFile(path.join(destination, 'agent-proof.txt'), marker),
    response: checkExactFile(path.join(destination, 'response.txt'), marker),
    completion: 'missing',
  };
  try {
    const contents = readBoundedFile(hostLog, MAX_HOST_LOG_BYTES).toString('utf8');
    const lines = contents.split('\n');
    const tail = lines.pop();
    if (lines.includes(COMPLETION_MARKER)) report.completion = 'match-lf';
    else if (lines.includes(`${COMPLETION_MARKER}\r`)) report.completion = 'match-crlf';
    else if (tail === COMPLETION_MARKER || tail === `${COMPLETION_MARKER}\r`) report.completion = 'unterminated';
    else if (contents.includes(COMPLETION_MARKER)) report.completion = 'embedded-or-decorated';
    else if (contents.includes('AWF-REGRESSION-COMPLET')) report.completion = 'partial';
  } catch (error) {
    report.completion = error.code === 'ENOENT' ? 'missing' : 'rejected';
  }
  fs.writeFileSync(path.join(destination, 'marker-check.json'), `${JSON.stringify(report)}\n`,
    { mode: 0o600, flag: 'wx' });
}

function collectCodexRoutingEvidence(filename, destination) {
  const diagnostics = {
    malformed: 0, wrongSource: 0, wrongProvider: 0, wrongPath: 0, invalidStatus: 0,
    starts: 0, ends: 0, noUsage: 0, pending: 0, partialLine: false, truncated: false,
  };
  const report = { source: 'api-proxy-token-tracker-audit', status: 'unavailable', diagnostics, requests: [] };
  try {
    const contents = readBoundedFile(filename, MAX_ROUTING_BYTES).toString('utf8');
    const lines = contents.split('\n');
    diagnostics.partialLine = lines.pop() !== '';
    report.status = 'empty';
    const pending = new Set();
    for (const line of lines) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { diagnostics.malformed++; continue; }
      if (!record || !Number.isFinite(record.ts) || typeof record.event !== 'string') {
        diagnostics.wrongSource++;
        continue;
      }
      if (['TRACK_END', 'WS_TRACK_END'].includes(record.event)) {
        if (pending.delete(record.rid)) {
          diagnostics.ends++;
          if (record.result === 'no_usage') diagnostics.noUsage++;
        }
        continue;
      }
      if (!['TRACK_START', 'WS_TRACK_START', 'WS_UPSTREAM_RESPONSE'].includes(record.event)) continue;
      if (record.provider !== 'openai') { diagnostics.wrongProvider++; continue; }
      // Project a fixed endpoint only; never publish URL queries or other paths.
      const endpoint = typeof record.path === 'string' ? record.path.split('?')[0] : '';
      if (!['/responses', '/v1/responses'].includes(endpoint)) { diagnostics.wrongPath++; continue; }
      if (typeof record.rid !== 'string' || record.rid.length > 200) { diagnostics.wrongSource++; continue; }
      if (record.event !== 'WS_UPSTREAM_RESPONSE') {
        diagnostics.starts++;
        pending.add(record.rid);
      }
      if (record.event === 'WS_TRACK_START') continue;
      const websocket = record.event === 'WS_UPSTREAM_RESPONSE';
      if (!Number.isInteger(record.status) ||
          !(record.status >= (websocket ? 100 : 200) && record.status <= 599)) {
        diagnostics.invalidStatus++;
        continue;
      }
      if (report.requests.length === MAX_ROUTING_RECORDS) { diagnostics.truncated = true; break; }
      report.requests.push({ transport: websocket ? 'websocket' : 'http', path: endpoint, status: record.status });
    }
    diagnostics.pending = pending.size;
    if (report.requests.some(request => request.transport === 'websocket' ?
      request.status === 101 : request.status >= 200 && request.status < 300)) {
      report.status = 'successful';
    } else if (report.requests.length) report.status = 'failed';
    else if (diagnostics.malformed || diagnostics.wrongSource || diagnostics.invalidStatus || diagnostics.partialLine) {
      report.status = 'rejected';
    }
  } catch (error) {
    // Missing or unsafe evidence is not proof of sidecar routing.
    report.status = error.code === 'ENOENT' ? 'unavailable' : 'rejected';
  }
  fs.writeFileSync(path.join(destination, 'codex-routing.json'), `${JSON.stringify(report)}\n`,
    { mode: 0o600, flag: 'wx' });
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
      fd = fs.openSync(
        sourcePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES || total + opened.size > MAX_TOTAL_BYTES) continue;
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES || total + length > MAX_TOTAL_BYTES) continue;
      const contents = redact(buffer.subarray(0, length).toString('utf8'), secrets);
      const contentSize = Buffer.byteLength(contents);
      if (contentSize > MAX_FILE_BYTES || total + contentSize > MAX_TOTAL_BYTES) continue;
      const targetPath = path.join(target, name);
      fs.writeFileSync(targetPath, contents, { mode: 0o600, flag: 'wx' });
      total += contentSize;
      copied.push(name);
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return copied;
}

module.exports = { collectAgentRegressionEvidence, collectCodexRoutingEvidence, collectMarkerCheck, assertDirectoryChain, redact, FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };

if (process.env.AWF_COLLECT_AGENT_REGRESSION_EVIDENCE === '1') {
  const [sourceDirectory, destination, hostLog, marker, codexAuditFile] = process.argv.slice(1);
  if (!sourceDirectory || !destination) throw new Error('Evidence source and destination are required');
  collectAgentRegressionEvidence(sourceDirectory, destination, [
    process.env.COPILOT_GITHUB_TOKEN,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ]);
  if (hostLog && marker) collectMarkerCheck(hostLog, destination, marker);
  if (codexAuditFile) collectCodexRoutingEvidence(codexAuditFile, destination);
}
