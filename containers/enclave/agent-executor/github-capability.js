'use strict';

const crypto = require('crypto');

const CAPABILITY_PREFIX = 'awf-egh1';
const CAPABILITY_AUDIENCE = 'gh-aw-enclave-github';
const CAPABILITY_PROFILE = 'issues-read-v1';
const CAPABILITY_OPERATIONS = Object.freeze([
  'issues.comments.list',
  'issues.get',
  'issues.list',
]);

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function assertIdentifier(name, value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`${name} is not a broker-generated identifier`);
  }
}

function mintGithubCapability(params) {
  if (typeof params.keyHex !== 'string' || !/^[0-9a-f]{64}$/.test(params.keyHex)) {
    throw new Error('GitHub capability root must be 256-bit lowercase hex');
  }
  assertIdentifier('runId', params.runId);
  assertIdentifier('invocationId', params.invocationId);
  if (
    typeof params.repo !== 'string'
    || params.repo !== params.repo.toLowerCase()
    || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(params.repo)
  ) {
    throw new Error('repo must be a canonical lowercase owner/repo');
  }
  if (
    !Number.isSafeInteger(params.notBefore)
    || !Number.isSafeInteger(params.expiresAt)
    || params.notBefore < 0
    || params.expiresAt <= params.notBefore
  ) {
    throw new Error('GitHub capability timestamps are invalid');
  }

  const payload = JSON.stringify({
    v: 1,
    aud: CAPABILITY_AUDIENCE,
    run: params.runId,
    inv: params.invocationId,
    repo: params.repo,
    profile: CAPABILITY_PROFILE,
    ops: CAPABILITY_OPERATIONS,
    nbf: params.notBefore,
    exp: params.expiresAt,
  });
  const encodedPayload = base64url(Buffer.from(payload, 'utf8'));
  const signingInput = `${CAPABILITY_PREFIX}.${encodedPayload}`;
  const mac = crypto
    .createHmac('sha256', Buffer.from(params.keyHex, 'hex'))
    .update(signingInput, 'ascii')
    .digest('base64url');
  return `${signingInput}.${mac}`;
}

module.exports = {
  CAPABILITY_AUDIENCE,
  CAPABILITY_OPERATIONS,
  CAPABILITY_PREFIX,
  CAPABILITY_PROFILE,
  mintGithubCapability,
};
