/**
 * Guard test: every local module reachable from the runtime entrypoint
 * (server.js) MUST be present in the Dockerfile COPY list.
 *
 * Background: the api-proxy image copies source files individually by name
 * (no bundler). When a refactor adds a new module but forgets to update the
 * Dockerfile, `require()` throws MODULE_NOT_FOUND inside the container. The
 * proxy's graceful-degradation guards then silently stub the affected
 * subsystem (e.g. token tracking, OTEL), so the container still boots but
 * produces no token-usage.jsonl — causing AI-credit accounting to report 0.
 *
 * This regression has happened at least twice (OIDC modules, then
 * token-tracker-shared.js). This test fails fast in CI instead.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRYPOINT = path.join(ROOT, 'server.js');

/** Resolve a relative require spec to an existing file path, or null. */
function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Compute the transitive closure of local (./ and ../) requires from an entry file. */
function computeRequireClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  const requireRe = /require\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g;

  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let m;
    while ((m = requireRe.exec(src)) !== null) {
      const resolved = resolveLocal(file, m[2]);
      if (resolved && !resolved.includes(`${path.sep}node_modules${path.sep}`)) {
        stack.push(resolved);
      }
    }
  }
  return seen;
}

/** Parse the Dockerfile into a set of copied files and copied directory prefixes. */
function parseDockerfileCopies(dockerfilePath) {
  const lines = fs.readFileSync(dockerfilePath, 'utf8').split('\n');
  const files = new Set();
  const dirs = new Set();

  let inCopy = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;

    let body = line;
    if (line.startsWith('COPY ')) {
      inCopy = true;
      body = line.slice('COPY '.length);
    } else if (!inCopy) {
      continue;
    }

    const continues = body.endsWith('\\');
    body = body.replace(/\\$/, '').trim();

    for (const tok of body.split(/\s+/)) {
      if (!tok || tok === '.' || tok === './') continue;
      const clean = tok.replace(/^\.\//, '');
      if (clean.endsWith('/')) {
        dirs.add(clean);
      } else if (/\.(js|json)$/.test(clean)) {
        files.add(clean);
      }
    }

    if (!continues) inCopy = false;
  }
  return { files, dirs };
}

describe('Dockerfile COPY coverage', () => {
  test('every module reachable from server.js is copied into the image', () => {
    const closure = computeRequireClosure(ENTRYPOINT);
    const { files, dirs } = parseDockerfileCopies(path.join(ROOT, 'Dockerfile'));

    const isCopied = (relPath) => {
      if (files.has(relPath)) return true;
      for (const dir of dirs) {
        if (relPath.startsWith(dir)) return true;
      }
      return false;
    };

    const missing = [...closure]
      .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('node_modules'))
      .filter((rel) => !isCopied(rel))
      .sort();

    expect(missing).toEqual([]);
  });
});
