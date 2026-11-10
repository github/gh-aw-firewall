'use strict';

const fs = require('node:fs');
const { grade, failureId } = require('./grade.cjs');
const { trace, boundedInteger } = require('./diagnostics.cjs');

function readSmallRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1) throw new Error('Invalid report file');
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > 4096) throw new Error('Report exceeded limit');
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function readReport(file) {
  return JSON.parse(readSmallRegularFile(file));
}

function collect(evidenceFile, reportFile, exitCode, output) {
  let state;
  const summary = { status: 'fail', stage: 'read_evidence',
    agentExit: boundedInteger(exitCode, 0, 255), failedAssertion: null, trace: [], upstream: [] };
  try {
    state = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    summary.trace = trace(state.events, state);
    summary.upstream = trace(state.upstream, state);
    summary.stage = 'read_report';
    const report = readReport(reportFile);
    summary.stage = 'grade';
    Object.assign(summary, grade(state, report, exitCode));
    summary.stage = 'complete';
  } catch (error) {
    summary.failedAssertion = failureId(error);
    // Agent output, assertion diffs and raw logs are untrusted and may contain secrets.
    console.error('Reflect smoke evidence failed the contract; see sanitized trace.');
  } finally {
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary.status === 'pass';
}

if (require.main === module) {
  if (process.argv[2] === '--version') {
    try {
      const version = readSmallRegularFile(process.argv[3]).match(/\b\d+\.\d+\.\d+\b/);
      if (!version) throw new Error('Missing version');
      fs.writeFileSync(process.argv[4], `${version[0]}\n`);
    } catch {
      console.error('Missing or invalid CLI version evidence');
      process.exitCode = 1;
    }
  } else {
    const [evidence, report, exitCode, output] = process.argv.slice(2);
    if (!collect(evidence, report, Number(exitCode), output)) process.exitCode = 1;
  }
}
module.exports = { collect, readReport };
