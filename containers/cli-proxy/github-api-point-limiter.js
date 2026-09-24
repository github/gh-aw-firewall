'use strict';

const REST_WRITE_POINTS = 5;
const READ_POINTS = 1;

function parseLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getApiInvocation(args) {
  let apiIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      if (arg === 'api') apiIndex = index;
      break;
    }
    if (!arg.includes('=') && index + 1 < args.length && !args[index + 1].startsWith('-')) {
      index += 1;
    }
  }
  if (apiIndex === -1) return null;
  let endpoint = null;
  let method = null;
  let invalidMethod = false;
  let hasField = false;
  const valueFlags = new Set(['--method', '-X', '--hostname', '-H', '--header', '-f', '-F', '--raw-field', '--field', '--input']);
  for (let index = apiIndex + 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--method=')) {
      method = arg.slice('--method='.length).toUpperCase();
      continue;
    }
    if (arg.startsWith('--field=') || arg.startsWith('--raw-field=') || arg.startsWith('-f=') || arg.startsWith('-F=')) {
      hasField = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      if (arg === '--method' || arg === '-X') {
        if (!args[index + 1] || args[index + 1].startsWith('-')) invalidMethod = true;
        else method = args[index + 1].toUpperCase();
      }
      if (arg === '--field' || arg === '--raw-field' || arg === '-f' || arg === '-F') hasField = true;
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') && endpoint === null) endpoint = arg;
  }
  if (!endpoint || invalidMethod) return null;
  if (endpoint === 'graphql') return { kind: 'graphql', points: READ_POINTS };

  method ||= hasField ? 'POST' : 'GET';
  return { kind: 'rest', points: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? READ_POINTS : REST_WRITE_POINTS };
}

class GitHubApiPointLimiter {
  constructor({ maxRest = null, maxGraphql = null } = {}) {
    this.maxRest = maxRest;
    this.maxGraphql = maxGraphql;
    this.usedRest = 0;
    this.usedGraphql = 0;
  }

  check(args) {
    const invocation = getApiInvocation(args);
    if (!invocation) return { allowed: true };
    const isGraphql = invocation.kind === 'graphql';
    const max = isGraphql ? this.maxGraphql : this.maxRest;
    const used = isGraphql ? this.usedGraphql : this.usedRest;
    if (max !== null && used + invocation.points > max) {
      return { allowed: false, ...invocation, limit: max, used, remaining: Math.max(0, max - used) };
    }
    if (isGraphql) this.usedGraphql += invocation.points;
    else this.usedRest += invocation.points;
    return {
      allowed: true,
      ...invocation,
      limit: max,
      used: isGraphql ? this.usedGraphql : this.usedRest,
      remaining: max === null ? null : max - (isGraphql ? this.usedGraphql : this.usedRest),
    };
  }
}

function createFromEnv(env = process.env) {
  return new GitHubApiPointLimiter({
    maxRest: parseLimit(env.AWF_MAX_GITHUB_API_POINTS_REST),
    maxGraphql: parseLimit(env.AWF_MAX_GITHUB_API_POINTS_GRAPHQL),
  });
}

module.exports = { GitHubApiPointLimiter, createFromEnv, getApiInvocation };
