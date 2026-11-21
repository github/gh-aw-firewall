'use strict';

const WRITE_POINTS = 5;
const READ_POINTS = 1;

function parseLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isGraphqlRequest(url) {
  const path = decodeURIComponent(url.split('?', 1)[0]).replace(/\/+/g, '/');
  let pathname = new URL(`http://localhost${path}`).pathname.replace(/\/+$/, '');
  while (pathname.startsWith('/api/v3/')) pathname = pathname.slice('/api/v3'.length);
  return pathname === '/graphql' || pathname === '/api/graphql';
}

function* tokenizeGraphql(query) {
  for (let index = 0; index < query.length;) {
    const char = query[index];
    if (/[\s,\uFEFF]/.test(char)) {
      index += 1;
    } else if (char === '#') {
      while (index < query.length && !/[\r\n]/.test(query[index])) index += 1;
    } else if (char === '"') {
      const block = query.startsWith('"""', index);
      index += block ? 3 : 1;
      let closed = false;
      while (index < query.length) {
        // GraphQL block strings escape only a triple quote, not arbitrary
        // backslash pairs. Ordinary strings escape their next character.
        if (block && query.startsWith('\\"""', index)) index += 4;
        else if (block ? query.startsWith('"""', index) : query[index] === '"') {
          index += block ? 3 : 1;
          closed = true;
          break;
        } else if (!block && query[index] === '\\') index += 2;
        else index += 1;
      }
      if (!closed) {
        yield null;
        return;
      }
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < query.length && /[A-Za-z0-9_]/.test(query[index])) index += 1;
      yield { type: 'name', value: query.slice(start, index) };
    } else {
      yield { type: 'punctuation', value: char };
      index += 1;
    }
  }
}

function isReadOnlyGraphql(query) {
  let operations = 0;
  let readOnly = true;
  let definitionHeader = false;
  let inDefinition = false;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;

  for (const token of tokenizeGraphql(query)) {
    if (!token) return false;
    if (inDefinition) {
      if (token.value === '{') braces += 1;
      else if (token.value === '}') {
        braces -= 1;
        if (braces < 0) return false;
        if (braces === 0) {
          if (parentheses !== 0 || brackets !== 0) return false;
          inDefinition = false;
        }
      } else if (token.value === '(') parentheses += 1;
      else if (token.value === ')') {
        parentheses -= 1;
        if (parentheses < 0) return false;
      } else if (token.value === '[') brackets += 1;
      else if (token.value === ']') {
        brackets -= 1;
        if (brackets < 0) return false;
      }
      continue;
    }

    if (definitionHeader) {
      if (token.value === '(') parentheses += 1;
      else if (token.value === ')') {
        parentheses -= 1;
        if (parentheses < 0) return false;
      } else if (token.value === '[') brackets += 1;
      else if (token.value === ']') {
        brackets -= 1;
        if (brackets < 0) return false;
      } else if (token.value === '{') {
        if (parentheses === 0 && brackets === 0 && braces === 0) {
          braces = 1;
          inDefinition = true;
          definitionHeader = false;
        } else {
          braces += 1;
        }
      } else if (token.value === '}') {
        braces -= 1;
        if (braces < 0) return false;
      }
      continue;
    }

    if (token.type === 'punctuation' && token.value === '{') {
      operations += 1;
      braces = 1;
      inDefinition = true;
    } else if (token.type === 'name' && token.value === 'fragment') {
      definitionHeader = true;
    } else if (token.type === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
      operations += 1;
      if (token.value !== 'query') readOnly = false;
      definitionHeader = true;
    } else {
      return false;
    }
  }

  return operations > 0 && readOnly && !definitionHeader && !inDefinition &&
    braces === 0 && parentheses === 0 && brackets === 0;
}

function getRequestCost(method, url, body) {
  if (!isGraphqlRequest(url)) {
    return { kind: 'rest', points: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? READ_POINTS : WRITE_POINTS };
  }

  let query;
  try {
    query = method === 'GET'
      ? new URL(url, 'http://localhost').searchParams.get('query')
      : JSON.parse(body.toString('utf8')).query;
  } catch {
    return { kind: 'graphql', points: WRITE_POINTS };
  }
  if (typeof query !== 'string') return { kind: 'graphql', points: WRITE_POINTS };

  // Ignore comments and string values. Price ambiguous/multi-operation
  // documents conservatively: any mutation costs five even with operationName.
  return { kind: 'graphql', points: isReadOnlyGraphql(query) ? READ_POINTS : WRITE_POINTS };
}

class GitHubApiPointLimiter {
  constructor({ maxRest = null, maxGraphql = null } = {}) {
    this.maxRest = maxRest;
    this.maxGraphql = maxGraphql;
    this.usedRest = 0;
    this.usedGraphql = 0;
  }

  check(method, url, body) {
    const invocation = getRequestCost(method, url, body);
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

module.exports = { GitHubApiPointLimiter, createFromEnv, getRequestCost, isGraphqlRequest };
