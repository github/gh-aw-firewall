'use strict';

const fs = require('node:fs');
const {
  MAX_PROBE_BYTES, unavailable, validateObservation, eligibilityEvidence,
} = require('./catalogue-contract/harness-observation');

// AWF-owned process configuration and the existing sidecar log mount only.
// No request field, User-Agent, remote catalogue or compiler overlay is read.
function readHarnessObservation() {
  if (!process.env.AWF_HARNESS_ENVIRONMENT) return undefined;
  const context = {
    environment: process.env.AWF_HARNESS_ENVIRONMENT,
    ...(process.env.AWF_SELECTED_HARNESS ? {
      name: process.env.AWF_SELECTED_HARNESS, binary: process.env.AWF_HARNESS_BINARY,
    } : {}),
  };
  let fd;
  try {
    fd = fs.openSync('/var/log/api-proxy/harness-observation.json',
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    const writableByGroupOrOthers = (stat.mode & 0o022) !== 0;
    const untrustedOwner = stat.uid !== 0;
    if (!stat.isFile()
      || stat.size > MAX_PROBE_BYTES
      || writableByGroupOrOthers
      || untrustedOwner) return unavailable(context, 'observation_invalid');
    const buffer = Buffer.alloc(MAX_PROBE_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_PROBE_BYTES) return unavailable(context, 'observation_invalid');
    return validateObservation(JSON.parse(buffer.subarray(0, count).toString('utf8')), context);
  } catch (error) {
    return unavailable(context, error.code === 'ENOENT' ? 'observation_missing' : 'observation_invalid');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function pinHarnessObservation(snapshot) {
  const report = readHarnessObservation();
  if (!report) return snapshot;
  return Object.freeze({
    revision: snapshot.revision,
    evaluate: input => snapshot.evaluate({ ...input, ...eligibilityEvidence(report, input.scope) }),
  });
}

module.exports = { readHarnessObservation, pinHarnessObservation };
