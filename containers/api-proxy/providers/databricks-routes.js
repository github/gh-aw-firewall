'use strict';

const { buildUpstreamPath } = require('../proxy-utils');

const prefix = '(?:/serving-endpoints|/ai-gateway/(?:openai|anthropic))?';
const inference = new RegExp(`^${prefix}/(?:v1/)?(?:chat/completions|completions|embeddings|responses|messages|messages/count_tokens)$`);
const discovery = new RegExp(`^${prefix}/(?:v1/)?models(?:/[A-Za-z0-9._-]+)?$`);
const invocation = /^\/serving-endpoints\/[A-Za-z0-9_-]+\/invocations$/;

function isDatabricksPathAllowed(method, path, headers = {}) {
  if (Object.keys(headers).some(name => name.toLowerCase() === 'upgrade')
    || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const pathname = path.split('?')[0];
  if (/[\\%#\s]/.test(pathname) || /\/\/|\/\.{1,2}(?:\/|$)/.test(pathname)) return false;
  if (method === 'GET') return discovery.test(pathname);
  return method === 'POST' && (inference.test(pathname) || invocation.test(pathname));
}

function isDatabricksRequestAllowed(req, targetHost, basePath) {
  try {
    // Validate before URL parsing, which would otherwise normalize traversal.
    const rawPath = req.url.split('?')[0];
    if (/[\\%#\s]/.test(rawPath) || /\/\/|\/\.{1,2}(?:\/|$)/.test(rawPath)) return false;
    return isDatabricksPathAllowed(req.method, buildUpstreamPath(req.url, targetHost, basePath), req.headers);
  } catch {
    return false;
  }
}

module.exports = { isDatabricksPathAllowed, isDatabricksRequestAllowed };
