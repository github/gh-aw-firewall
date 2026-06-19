'use strict';

// ──────────────────────────────────────────────────────────────────────────
// TEMPORARY DEBUG CAPTURE — DO NOT MERGE.
//
// Captures the raw OpenAI /responses upstream request bodies and the raw
// usage-bearing SSE lines so we can determine, from real CI artifacts, why
// codex runs report cache_read_tokens=0 (is the prompt prefix cache-stable
// across turns? is input_tokens_details.cached_tokens absent or literally 0?).
//
// Output: ${AWF_TOKEN_LOG_DIR or /var/log/api-proxy}/responses-debug/
//   - <seq>-<requestId>.request.json   (full upstream request body)
//   - usage-lines.jsonl                (every SSE line that carried "usage")
//   - index.jsonl                      (per-request prefix fingerprint summary)
//
// Bodies for /responses contain the prompt but NOT credentials (the API key
// rides in the Authorization header, which is never captured here). This file
// and its two call sites must be reverted before any real merge.
// ──────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = process.env.AWF_TOKEN_LOG_DIR || '/var/log/api-proxy';
const OUT_DIR = path.join(BASE_DIR, 'responses-debug');

let seq = 0;
let ready = false;

function ensureDir() {
  if (ready) return true;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    ready = true;
  } catch {
    ready = false;
  }
  return ready;
}

function isResponsesPath(p) {
  if (typeof p !== 'string') return false;
  const pathOnly = p.split('?')[0];
  return /^\/?(?:v\d+\/)?responses(?:\/|$)/.test(pathOnly);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Summarize an OpenAI Responses request body for cache-prefix analysis:
 * the leading content that determines the cache-routing hash (first ~256
 * tokens ≈ first ~1KB of the rendered instructions / first input item).
 */
function summarizeBody(text) {
  const out = {
    bytes: Buffer.byteLength(text, 'utf8'),
    body_sha256: sha256(text),
  };
  try {
    const json = JSON.parse(text);
    out.model = json.model ?? null;
    out.store = json.store ?? null;
    out.prompt_cache_key = json.prompt_cache_key ?? null;
    out.has_previous_response_id = json.previous_response_id != null;
    out.stream = json.stream ?? null;
    // `instructions` is the static system prefix; capture a stable fingerprint
    // plus a short head/tail so we can eyeball any dynamic content.
    if (typeof json.instructions === 'string') {
      out.instructions_len = json.instructions.length;
      out.instructions_sha256 = sha256(json.instructions);
      out.instructions_head = json.instructions.slice(0, 400);
      out.instructions_tail = json.instructions.slice(-200);
    }
    if (Array.isArray(json.input)) {
      out.input_count = json.input.length;
      const first = json.input[0];
      out.input0 = first ? JSON.stringify(first).slice(0, 600) : null;
      out.input0_sha256 = first ? sha256(JSON.stringify(first)) : null;
      if (Array.isArray(json.tools)) {
        out.tools_count = json.tools.length;
        out.tools_sha256 = sha256(JSON.stringify(json.tools));
      }
    }
    // First ~1KB of the canonicalized prompt-bearing fields, which is what the
    // cache-routing prefix hash is computed over.
    const prefixSource = (json.instructions || '') + '\u0000' +
      (Array.isArray(json.input) ? JSON.stringify(json.input[0] || '') : '');
    out.prefix_1k_sha256 = sha256(prefixSource.slice(0, 1024));
  } catch (err) {
    out.parse_error = String(err && err.message);
  }
  return out;
}

function captureRequest(upstreamPath, body) {
  try {
    if (!isResponsesPath(upstreamPath)) return;
    if (!ensureDir()) return;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    const n = ++seq;
    const reqId = (typeof arguments[2] === 'string' && arguments[2]) || `req${n}`;
    fs.writeFileSync(
      path.join(OUT_DIR, `${String(n).padStart(2, '0')}-${reqId}.request.json`),
      text,
    );
    const summary = { seq: n, request_id: reqId, path: upstreamPath, ts: new Date().toISOString(), ...summarizeBody(text) };
    fs.appendFileSync(path.join(OUT_DIR, 'index.jsonl'), JSON.stringify(summary) + '\n');
  } catch {
    /* never break the proxy on debug failure */
  }
}

function captureUsageLine(requestId, line) {
  try {
    if (typeof line !== 'string') return;
    if (!line.includes('"usage"') && !line.includes('input_tokens_details') &&
        !line.includes('response.completed') && !line.includes('response.done')) {
      return;
    }
    if (!ensureDir()) return;
    fs.appendFileSync(
      path.join(OUT_DIR, 'usage-lines.jsonl'),
      JSON.stringify({ request_id: requestId, ts: new Date().toISOString(), line }) + '\n',
    );
  } catch {
    /* never break the proxy on debug failure */
  }
}

module.exports = { captureRequest, captureUsageLine, isResponsesPath };
