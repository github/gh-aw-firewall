'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { logRequest } = require('./logging');
const { validateTariffs } = require('./catalogue-pricing');
const { buildSnapshot, validateSnapshot, schemaHash } = require('./catalogue-contract/publication.cjs');
const { json, digest, isCommit, readPointer } = require('./catalogue-contract/publication-contract.cjs');

const ROOT = 'https://api.github.com/repos/github/gh-aw-firewall';
const MAX_BYTES = 8 * 1024 * 1024;

function ensurePrivateCacheDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) fail('catalogue_cache_permissions');
  return directory;
}
const DEFAULT_AGE = 30 * 24 * 3600;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function immutable(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

// No redirects, ambient credentials, decompression, or direct retry on proxy failure.
function getBytes(url, { signal, timeoutMs = 5000 } = {}) {
  const { proxyAgent } = require('./http-client');
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      reject(new Error('catalogue_source_invalid'));
      return;
    }
    const request = https.get(parsed, {
      agent: proxyAgent, signal,
      headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'awf-catalogue-v1' },
    }, response => {
      if (response.statusCode !== 200 || response.headers['content-encoding'] ||
          Number(response.headers['content-length']) > MAX_BYTES) {
        response.destroy();
        reject(new Error(`catalogue_http_${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy(new Error('catalogue_oversize'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('catalogue_response_aborted')));
    });
    const timer = setTimeout(() => request.destroy(new Error('catalogue_timeout')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

function positive(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('catalogue_option_invalid');
  return value;
}

function optionsFromEnv(env = process.env) {
  return env.AWF_MODEL_CATALOGUE ? JSON.parse(env.AWF_MODEL_CATALOGUE) : {};
}

function createCatalogueLoader(options = {}, deps = {}) {
  const now = deps.now || Date.now;
  const read = deps.getBytes || getBytes;
  const report = deps.report || ((level, data) => logRequest(level, 'model_catalogue', data));
  const source = options.source || 'github';
  const enabled = options.enabled !== false;
  const offline = options.offline === true;
  const maxAge = positive(options.maxAgeSeconds, DEFAULT_AGE, 1, 365 * 24 * 3600) * 1000;
  const interval = positive(options.refreshSeconds, 3600, 60, 24 * 3600) * 1000;
  const timeoutMs = positive(options.timeoutMs, 5000, 100, 30000);
  const local = options.localSnapshot;
  if ((source !== 'github' || local) && options.trustSource !== true) fail('catalogue_operator_trust_required');
  if (source !== 'github') {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('catalogue_source_invalid');
  }
  // Cache storage is operator-controlled proxy-private state, never an agent log/artifact mount.
  const cacheKey = digest(json({ source, local: local ? digest(json(local)) : null, schemaHash }));
  const cacheDirectory = options.cacheDirectory ||
    path.join(os.tmpdir(), `awf-model-catalogue-${process.getuid?.() ?? 'proxy'}`);
  const cacheFile = path.join(cacheDirectory, `${cacheKey}.json`);
  let active = null;
  let acceptedSource = null;
  const sourceLabel = local ? `local:${digest(json(local)).slice(0, 16)}`
    : source === 'github' ? 'github/gh-aw-firewall' : `operator:${digest(source).slice(0, 16)}`;
  let status = { source: sourceLabel, state: enabled ? 'pending' : 'disabled' };
  let pending = null;
  let timer = null;
  let stopped = false;
  let controller = null;
  let started = null;

  function parse(bytes) {
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('catalogue_oversize');
    return JSON.parse(bytes);
  }
  async function fetchBytes(url) {
    const bytes = await read(url, { signal: controller.signal, timeoutMs });
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('catalogue_oversize');
    return bytes;
  }
  const api = async suffix => parse(await fetchBytes(`${ROOT}${suffix}`));
  async function ancestor(base, head) {
    if (!isCommit(base) || !isCommit(head)) fail('catalogue_commit_invalid');
    if (base === head) return;
    const comparison = await api(`/compare/${base}...${head}?per_page=1`);
    if (!['ahead', 'identical'].includes(comparison.status) ||
        comparison.merge_base_commit?.sha !== base) fail('catalogue_source_regression');
  }
  async function reviewed(commit) {
    if (!isCommit(commit)) fail('catalogue_commit_invalid');
    const metadata = await api(`/git/commits/${commit}`);
    if (metadata.sha !== commit || !metadata.committer?.date) fail('catalogue_commit_invalid');
    const catalogue = parse(await fetchBytes(`${ROOT}/contents/shared/model-information/catalog.generated.json?ref=${commit}`));
    return buildSnapshot(catalogue, commit, metadata.committer.date);
  }
  async function preservesAcceptedSource(head) {
    if (!acceptedSource || acceptedSource === head) return;
    // Keep private cache bytes local. Only the network-authenticated candidate
    // selects the history query; compare its reachable commits to the cache here.
    for (let page = 1; page <= 10; page++) {
      const commits = await api(`/commits?sha=${head}&per_page=100&page=${page}`);
      if (!Array.isArray(commits)) fail('catalogue_commit_invalid');
      if (commits.some(commit => commit.sha === acceptedSource)) return;
      if (commits.length < 100) fail('catalogue_source_regression');
    }
    fail('catalogue_source_history_unavailable');
  }
  async function githubCandidate() {
    const ref = await api('/git/ref/heads/catalogue-data');
    const dataCommit = ref.object?.sha;
    if (ref.ref !== 'refs/heads/catalogue-data' || ref.object?.type !== 'commit' ||
        !isCommit(dataCommit)) fail('catalogue_ref_invalid');
    const pointerBytes = await fetchBytes(`${ROOT}/contents/channels/v1/current.json?ref=${dataCommit}`);
    const pointer = readPointer(pointerBytes);
    const snapshotBytes = await fetchBytes(`${ROOT}/contents/${pointer.snapshot}?ref=${dataCommit}`);
    const snapshot = validateSnapshot(snapshotBytes);
    if (digest(snapshotBytes) !== pointer.sha256 || snapshot.revision !== pointer.revision) {
      fail('catalogue_digest_invalid');
    }
    const main = await api('/git/ref/heads/main');
    if (main.ref !== 'refs/heads/main' || main.object?.type !== 'commit') fail('catalogue_ref_invalid');
    await ancestor(pointer.sourceCommit, main.object?.sha);
    await ancestor(snapshot.sourceCommit, pointer.sourceCommit);
    await preservesAcceptedSource(pointer.sourceCommit);
    // Authenticate all envelope bytes against the original reviewed source, including rollback time.
    const original = await reviewed(snapshot.sourceCommit);
    if (original !== snapshotBytes.toString()) fail('catalogue_reviewed_bytes_mismatch');
    const current = snapshot.sourceCommit === pointer.sourceCommit ? original : await reviewed(pointer.sourceCommit);
    if (JSON.parse(current).revision !== snapshot.revision) fail('catalogue_reviewed_revision_mismatch');
    return { snapshot: snapshotBytes.toString(), pointer, dataCommit };
  }

  function validateCandidate(candidate) {
    const snapshot = validateSnapshot(candidate.snapshot);
    if (source === 'github' && !local) {
      const pointer = readPointer(json(candidate.pointer));
      if (pointer.revision !== snapshot.revision || pointer.sha256 !== digest(candidate.snapshot) ||
          !isCommit(candidate.dataCommit)) fail('catalogue_cache_invalid');
    }
    const time = now();
    const published = Date.parse(snapshot.publishedAt);
    if (published > time || Date.parse(snapshot.effectiveFrom) > time ||
        Date.parse(snapshot.observedAt) > time || time - published > maxAge ||
        time - Date.parse(snapshot.observedAt) > maxAge) fail('catalogue_stale_or_future');
    // No execution attestation infrastructure is introduced by this bounded loader.
    if (snapshot.models.some(model => model.harnesses?.length)) fail('catalogue_harness_unsupported');
    validateTariffs(snapshot);
    return snapshot;
  }
  function save(candidate) {
    if (!cacheFile) return;
    ensurePrivateCacheDirectory(cacheDirectory);
    const temporary = `${cacheFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, json({ schemaHash, cacheKey, candidate }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, cacheFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  function activate(candidate, origin) {
    const snapshot = validateCandidate(candidate);
    active = immutable({ ...candidate, value: snapshot, acceptedAt: now() });
    acceptedSource = candidate.pointer?.sourceCommit || null;
    status = { ...status, state: 'active', origin, revision: snapshot.revision,
      sourceCommit: candidate.pointer?.sourceCommit || snapshot.sourceCommit,
      publishedAt: snapshot.publishedAt, observedAt: snapshot.observedAt, failure: null };
    report('info', status);
  }
  function failure(error, unusable = false) {
    // Never log transport exception strings: they can contain configured URLs or credentials.
    const reason = /^catalogue_[a-z0-9_]+$/.test(error.message) ? error.message : 'catalogue_invalid_or_unavailable';
    const state = active && !unusable ? 'fallback_cache' : 'fallback_bundled';
    const unchanged = status.failure === reason && status.state === state;
    status = { ...status, failure: reason, state };
    if (unchanged) return;
    report('warn', status);
  }
  function refresh() {
    if (pending) return pending;
    if (!enabled || offline || local || stopped) return Promise.resolve();
    controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    pending = (async () => {
      try {
        const candidate = source === 'github' ? await githubCandidate()
          : { snapshot: json(parse(await fetchBytes(source))) };
        validateCandidate(candidate);
        if (stopped) return;
        if (active?.value.revision === JSON.parse(candidate.snapshot).revision &&
            active.snapshot !== candidate.snapshot) fail('catalogue_immutable_revision_changed');
        save(candidate);
        activate(candidate, 'network');
      } catch (error) {
        if (!stopped) failure(error);
      } finally {
        clearTimeout(deadline);
        pending = null;
      }
    })();
    return pending;
  }
  async function initialize() {
    if (!enabled || stopped) return;
    if (local) {
      try { activate({ snapshot: json(local) }, 'local'); } catch (error) { failure(error); }
      return;
    }
    if (cacheFile) {
      try {
        const directory = fs.lstatSync(cacheDirectory);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) ||
            (process.getuid && directory.uid !== process.getuid())) fail('catalogue_cache_permissions');
        const fd = fs.openSync(cacheFile,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
        let cached;
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || (stat.mode & 0o077) || stat.size > MAX_BYTES ||
              (process.getuid && stat.uid !== process.getuid())) fail('catalogue_cache_invalid');
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          let size = 0;
          while (size < bytes.length) {
            const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
            if (!count) break;
            size += count;
          }
          cached = parse(bytes.subarray(0, size));
        } finally {
          fs.closeSync(fd);
        }
        if (cached.schemaHash !== schemaHash || cached.cacheKey !== cacheKey) fail('catalogue_cache_invalid');
        if (source === 'github') acceptedSource = readPointer(json(cached.candidate.pointer)).sourceCommit;
        activate(cached.candidate, 'cache');
      } catch (error) {
        if (error.code !== 'ENOENT') failure(error);
      }
    }
    if (offline) {
      status = { ...status, state: active ? 'offline_cache' : 'offline_bundled' };
      report('info', status);
      return;
    }
    await refresh();
    if (!stopped && !timer) {
      timer = setInterval(refresh, interval);
      timer.unref();
    }
  }
  function start() {
    if (!started) started = initialize();
    return started;
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
    await pending;
  }
  function capture() {
    const candidate = active;
    if (!candidate) return null;
    try { validateCandidate(candidate); } catch (error) {
      failure(error, true);
      return null;
    }
    return Object.freeze({ snapshot: candidate.value, time: now(), maxAge,
      source: status.source, revision: candidate.value.revision });
  }
  function reflect() {
    if (active) {
      try { validateCandidate(active); } catch (error) { failure(error, true); }
    }
    return { ...status,
      ageSeconds: active ? Math.max(0, Math.floor((now() - Date.parse(active.value.publishedAt)) / 1000)) : null };
  }
  return { start, refresh, stop, capture, reflect };
}

let singleton;
function getCatalogueLoader() {
  if (!singleton) singleton = createCatalogueLoader(optionsFromEnv());
  return singleton;
}

module.exports = { createCatalogueLoader, getCatalogueLoader, getBytes, optionsFromEnv };
