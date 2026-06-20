/**
 * Token usage parsers for AWF API Proxy.
 *
 * Pure parsing and normalization functions — no I/O, no side effects.
 * Covers SSE streaming, non-streaming JSON, decompression helpers, and
 * usage normalization into a unified format.
 */

'use strict';

const zlib = require('zlib');

/**
 * Check if a response is SSE (Server-Sent Events) streaming.
 */
function isStreamingResponse(headers) {
  const ct = headers['content-type'] || '';
  return ct.includes('text/event-stream');
}

/**
 * Check if a response is gzip or deflate compressed.
 */
function isCompressedResponse(headers) {
  const ce = (headers['content-encoding'] || '').toLowerCase();
  return ce === 'gzip' || ce === 'deflate' || ce === 'br';
}

/**
 * Create a decompression transform stream based on content-encoding.
 * Returns null if the encoding is not supported.
 */
function createDecompressor(headers) {
  const ce = (headers['content-encoding'] || '').toLowerCase();
  if (ce === 'gzip') return zlib.createGunzip();
  if (ce === 'deflate') return zlib.createInflate();
  if (ce === 'br') return zlib.createBrotliDecompress();
  return null;
}

/**
 * Extract reasoning token count from provider usage payloads.
 *
 * Supports explicit `reasoning_tokens` and provider-specific nested fields.
 * Priority order: top-level → completion_tokens_details → output_tokens_details.
 */
function extractReasoningTokens(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  if (typeof usage.reasoning_tokens === 'number') return usage.reasoning_tokens;
  if (usage.completion_tokens_details && typeof usage.completion_tokens_details.reasoning_tokens === 'number') {
    return usage.completion_tokens_details.reasoning_tokens;
  }
  if (usage.output_tokens_details && typeof usage.output_tokens_details.reasoning_tokens === 'number') {
    return usage.output_tokens_details.reasoning_tokens;
  }
  return undefined;
}

function sumCacheReadFromEntries(entries) {
  let total = 0;
  let found = false;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.token_type === 'cache_read' && typeof entry.token_count === 'number') {
      total += entry.token_count;
      found = true;
    }

    if (Array.isArray(entry.details)) {
      const nested = sumCacheReadFromEntries(entry.details);
      if (typeof nested === 'number') {
        total += nested;
        found = true;
      }
    }
  }

  return found ? total : undefined;
}

/**
 * Scan token-entry containers for cache_read token entries.
 */
function findInTokenEntries(tokenContainers) {
  for (const container of tokenContainers) {
    if (!container || typeof container !== 'object') continue;
    const entries = Array.isArray(container)
      ? container
      : (Array.isArray(container.details) ? container.details : null);
    if (!entries) continue;

    const total = sumCacheReadFromEntries(entries);
    if (typeof total === 'number') return total;
  }

  return undefined;
}

/**
 * Extract cache-read token count from provider usage payloads.
 *
 * Supports:
 *  - Anthropic: usage.cache_read_input_tokens
 *  - OpenAI Chat Completions / Copilot: usage.prompt_tokens_details.cached_tokens
 *  - OpenAI Responses API: usage.input_tokens_details.cached_tokens
 *  - Token-entry arrays containing { token_type: "cache_read", token_count: <n> }
 */
function extractCacheReadTokens(usage) {
  if (!usage || typeof usage !== 'object') return undefined;

  if (typeof usage.cache_read_input_tokens === 'number') {
    return usage.cache_read_input_tokens;
  }

  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === 'number') {
    return usage.prompt_tokens_details.cached_tokens;
  }

  // OpenAI Responses API (/responses) reports cached prompt tokens under
  // `input_tokens_details.cached_tokens` (an object), rather than the Chat
  // Completions `prompt_tokens_details.cached_tokens`. Without this branch the
  // value falls through to the array loop below, which only handles token-entry
  // arrays, so cache reads are silently dropped (reported as 0).
  if (usage.input_tokens_details && typeof usage.input_tokens_details.cached_tokens === 'number') {
    return usage.input_tokens_details.cached_tokens;
  }

  const tokenContainers = [
    usage.prompt_tokens_details,
    usage.input_tokens_details,
    usage.token_details,
    usage.usage_details,
  ];
  return findInTokenEntries(tokenContainers);
}

function buildUsageFromSource(usageSource) {
  if (!usageSource || typeof usageSource !== 'object') return null;

  const usage = {};
  if (typeof usageSource.input_tokens === 'number') usage.input_tokens = usageSource.input_tokens;
  if (typeof usageSource.output_tokens === 'number') usage.output_tokens = usageSource.output_tokens;
  if (typeof usageSource.cache_creation_input_tokens === 'number') {
    usage.cache_creation_input_tokens = usageSource.cache_creation_input_tokens;
  }
  if (typeof usageSource.prompt_tokens === 'number') usage.prompt_tokens = usageSource.prompt_tokens;
  if (typeof usageSource.completion_tokens === 'number') usage.completion_tokens = usageSource.completion_tokens;
  if (typeof usageSource.total_tokens === 'number') usage.total_tokens = usageSource.total_tokens;

  const reasoningTokens = extractReasoningTokens(usageSource);
  if (typeof reasoningTokens === 'number') usage.reasoning_tokens = reasoningTokens;

  const cacheReadTokens = extractCacheReadTokens(usageSource);
  if (typeof cacheReadTokens === 'number') usage.cache_read_input_tokens = cacheReadTokens;

  return Object.keys(usage).length > 0 ? usage : null;
}

function mergeCopilotBreakdown(usage, json) {
  const copilotBreakdown = extractCopilotUsageBreakdown(json);
  if (!copilotBreakdown) return usage;

  const merged = { ...(usage || {}), ...copilotBreakdown };
  if (copilotBreakdown.input_tokens !== undefined) {
    // Copilot gave us a precise input split: drop the lumped prompt_tokens.
    delete merged.prompt_tokens;
  } else if (copilotBreakdown.cache_creation_input_tokens !== undefined
             && typeof merged.prompt_tokens === 'number') {
    // cache_write present but input absent: infer input = prompt_tokens - cache_write
    // to avoid double-counting cache_write in normalizeUsage.
    merged.input_tokens = Math.max(0, merged.prompt_tokens - copilotBreakdown.cache_creation_input_tokens);
    delete merged.prompt_tokens;
  }
  return merged;
}

function buildAnthropicMessageStartUsage(usage) {
  const out = {};
  if (typeof usage.input_tokens === 'number') out.input_tokens = usage.input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  const cacheReadTokens = extractCacheReadTokens(usage);
  if (typeof cacheReadTokens === 'number') out.cache_read_input_tokens = cacheReadTokens;
  return out;
}

function buildAnthropicMessageDeltaUsage(usage) {
  const out = {};
  if (typeof usage.output_tokens === 'number') out.output_tokens = usage.output_tokens;
  return out;
}

function buildResponseCompletionUsage(usage) {
  const out = {};
  if (typeof usage.input_tokens === 'number') out.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.output_tokens = usage.output_tokens;
  if (typeof usage.total_tokens === 'number') out.total_tokens = usage.total_tokens;
  const reasoningTokens = extractReasoningTokens(usage);
  if (typeof reasoningTokens === 'number') out.reasoning_tokens = reasoningTokens;
  const cacheReadTokens = extractCacheReadTokens(usage);
  if (typeof cacheReadTokens === 'number') out.cache_read_input_tokens = cacheReadTokens;
  return out;
}

function buildStreamingFinalChunkUsage(usage) {
  const out = {};
  if (typeof usage.prompt_tokens === 'number') out.prompt_tokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completion_tokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.total_tokens = usage.total_tokens;
  const reasoningTokens = extractReasoningTokens(usage);
  if (typeof reasoningTokens === 'number') out.reasoning_tokens = reasoningTokens;
  const cacheReadTokens = extractCacheReadTokens(usage);
  if (typeof cacheReadTokens === 'number') out.cache_read_input_tokens = cacheReadTokens;
  return out;
}

/**
 * Extract the authoritative per-type token breakdown from a Copilot
 * `copilot_usage.token_details` array.
 *
 * The GitHub Copilot OpenAI-compatible endpoint reports a flattened
 * `usage` object where `prompt_tokens` lumps fresh input together with
 * cache-write tokens, and `prompt_tokens_details.cached_tokens` only
 * carries cache-read. The true split (input / cache_read / cache_write /
 * output), which is billed at distinct rates, is only available in the
 * sibling `copilot_usage.token_details` array, e.g.:
 *
 *   copilot_usage: { token_details: [
 *     { token_type: "input",       token_count: 3857 },
 *     { token_type: "cache_read",  token_count: 0 },
 *     { token_type: "cache_write", token_count: 12539 },
 *     { token_type: "output",      token_count: 362 },
 *   ] }
 *
 * Returns Anthropic-normalized usage fields (input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens) so downstream
 * normalization records the correct cache_write split, or null when no
 * recognizable token_details are present.
 *
 * @param {object} json - Parsed response JSON (or SSE event object)
 * @returns {object|null}
 */
function extractCopilotUsageBreakdown(json) {
  if (!json || typeof json !== 'object') return null;
  const copilotUsage = (json.copilot_usage && typeof json.copilot_usage === 'object')
    ? json.copilot_usage
    : ((json.response && json.response.copilot_usage && typeof json.response.copilot_usage === 'object')
      ? json.response.copilot_usage
      : null);
  if (!copilotUsage || !Array.isArray(copilotUsage.token_details)) return null;

  const out = {};
  let found = false;
  for (const entry of copilotUsage.token_details) {
    if (!entry || typeof entry !== 'object') continue;
    const count = entry.token_count;
    if (typeof count !== 'number') continue;
    switch (entry.token_type) {
      case 'input':
        out.input_tokens = (out.input_tokens || 0) + count;
        found = true;
        break;
      case 'output':
        out.output_tokens = (out.output_tokens || 0) + count;
        found = true;
        break;
      case 'cache_read':
        out.cache_read_input_tokens = (out.cache_read_input_tokens || 0) + count;
        found = true;
        break;
      case 'cache_write':
        out.cache_creation_input_tokens = (out.cache_creation_input_tokens || 0) + count;
        found = true;
        break;
      default:
        break;
    }
  }
  return found ? out : null;
}

/**
 * Extract token usage from a non-streaming JSON response body.
 *
 * Supports:
 *   - OpenAI/Copilot: { usage: { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens } } }
 *   - Anthropic: { usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } }
 *
 * Also extracts the model field if present.
 *
 * @param {Buffer} body - Response body
 * @returns {{ usage: object|null, model: string|null }}
 */
function extractUsageFromJson(body) {
  try {
    const text = body.toString('utf8');
    const json = JSON.parse(text);
    const usageSource = (json.usage && typeof json.usage === 'object')
      ? json.usage
      : ((json.response && json.response.usage && typeof json.response.usage === 'object')
        ? json.response.usage
        : null);
    const result = { usage: null, model: json.model || (json.response && json.response.model) || null };
    result.usage = buildUsageFromSource(usageSource);
    result.usage = mergeCopilotBreakdown(result.usage, json);

    return result;
  } catch {
    return { usage: null, model: null };
  }
}

/**
 * Extract token usage from a single SSE data line.
 *
 * SSE format: "data: {json}\n\n"
 *
 * Anthropic streaming events with usage:
 *   - message_start: { type: "message_start", message: { usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *   - message_delta: { type: "message_delta", usage: { output_tokens } }
 *
 * OpenAI/Copilot streaming events with usage:
 *   - Final chunk: { usage: { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens } } }
 *
 * @param {string} line - A single SSE data line (without "data: " prefix)
 * @returns {{ usage: object|null, model: string|null }}
 */
function extractUsageFromSseLine(line) {
  if (!line || line === '[DONE]') return { usage: null, model: null };

  try {
    const json = JSON.parse(line);
    const result = { usage: null, model: json.model || null };

    // Anthropic message_start: usage is inside message object
    if (json.type === 'message_start' && json.message && json.message.usage) {
      result.usage = buildAnthropicMessageStartUsage(json.message.usage);
      result.model = (json.message && json.message.model) || result.model;
      return result;
    }

    // Anthropic message_delta: usage at top level
    if (json.type === 'message_delta' && json.usage) {
      result.usage = buildAnthropicMessageDeltaUsage(json.usage);
      return result;
    }

    // OpenAI Responses API: usage in response object on completion events
    if ((json.type === 'response.completed' || json.type === 'response.done')
      && json.response && json.response.usage && typeof json.response.usage === 'object') {
      result.usage = buildResponseCompletionUsage(json.response.usage);
      result.model = json.response.model || result.model;
      return result;
    }

    // OpenAI/Copilot: usage at top level in final chunk
    if (json.usage && typeof json.usage === 'object') {
      result.usage = buildStreamingFinalChunkUsage(json.usage);
      result.usage = mergeCopilotBreakdown(result.usage, json);
      return result;
    }

    return result;
  } catch {
    return { usage: null, model: null };
  }
}

/**
 * Extract all SSE data lines from a text chunk.
 * Lines are prefixed with "data: " in the SSE protocol.
 */
function parseSseDataLines(text) {
  const lines = [];
  const parts = text.split('\n');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('data: ')) {
      lines.push(trimmed.slice(6));
    } else if (trimmed === 'data:') {
      // empty data line
    }
  }
  return lines;
}

/**
 * Normalize extracted usage into a unified format.
 *
 * Output fields:
 *   - input_tokens: number (from Anthropic input_tokens or OpenAI prompt_tokens)
 *   - output_tokens: number (from Anthropic output_tokens or OpenAI completion_tokens)
 *   - cache_read_tokens: number (from Anthropic cache_read_input_tokens,
 *       OpenAI Chat Completions prompt_tokens_details.cached_tokens, or
 *       OpenAI Responses API input_tokens_details.cached_tokens)
 *   - cache_write_tokens: number (Anthropic cache_creation_input_tokens or
 *       Copilot copilot_usage cache_write; not available in flattened OpenAI usage)
 */
function normalizeUsage(usage) {
  if (!usage) return null;

  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_read_tokens: extractCacheReadTokens(usage) ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    reasoning_tokens: usage.reasoning_tokens ?? 0,
  };
}

module.exports = {
  isStreamingResponse,
  isCompressedResponse,
  createDecompressor,
  extractReasoningTokens,
  extractCacheReadTokens,
  extractCopilotUsageBreakdown,
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
};
