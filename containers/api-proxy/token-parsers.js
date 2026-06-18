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

/**
 * Extract cache-read token count from provider usage payloads.
 *
 * Supports:
 *  - Anthropic: usage.cache_read_input_tokens
 *  - OpenAI/Copilot: usage.prompt_tokens_details.cached_tokens
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

  const tokenContainers = [
    usage.prompt_tokens_details,
    usage.input_tokens_details,
    usage.token_details,
    usage.usage_details,
  ];

  for (const container of tokenContainers) {
    if (!container || typeof container !== 'object') continue;
    const entries = Array.isArray(container)
      ? container
      : (Array.isArray(container.details) ? container.details : null);
    if (!entries) continue;

    let total = 0;
    let found = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.token_type === 'cache_read') {
        const count = entry.token_count;
        if (typeof count === 'number') {
          total += count;
          found = true;
        }
      }
      if (Array.isArray(entry.details)) {
        for (const nested of entry.details) {
          if (!nested || typeof nested !== 'object') continue;
          if (nested.token_type !== 'cache_read') continue;
          const count = nested.token_count;
          if (typeof count === 'number') {
            total += count;
            found = true;
          }
        }
      }
    }
    if (found) return total;
  }

  return undefined;
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

    if (usageSource) {
      const usage = {};
      let hasField = false;
      // Anthropic fields
      if (typeof usageSource.input_tokens === 'number') {
        usage.input_tokens = usageSource.input_tokens;
        hasField = true;
      }
      if (typeof usageSource.output_tokens === 'number') {
        usage.output_tokens = usageSource.output_tokens;
        hasField = true;
      }
      if (typeof usageSource.cache_creation_input_tokens === 'number') {
        usage.cache_creation_input_tokens = usageSource.cache_creation_input_tokens;
        hasField = true;
      }
      // OpenAI/Copilot fields
      if (typeof usageSource.prompt_tokens === 'number') {
        usage.prompt_tokens = usageSource.prompt_tokens;
        hasField = true;
      }
      if (typeof usageSource.completion_tokens === 'number') {
        usage.completion_tokens = usageSource.completion_tokens;
        hasField = true;
      }
      if (typeof usageSource.total_tokens === 'number') {
        usage.total_tokens = usageSource.total_tokens;
        hasField = true;
      }
      const reasoningTokens = extractReasoningTokens(usageSource);
      if (typeof reasoningTokens === 'number') {
        usage.reasoning_tokens = reasoningTokens;
        hasField = true;
      }
      const cacheReadTokens = extractCacheReadTokens(usageSource);
      if (typeof cacheReadTokens === 'number') {
        usage.cache_read_input_tokens = cacheReadTokens;
        hasField = true;
      }
      if (hasField) {
        result.usage = usage;
      }
    }

    // Copilot exposes the authoritative input/cache_read/cache_write/output
    // split only in the sibling `copilot_usage.token_details` array. When
    // present, prefer it: the flattened `usage.prompt_tokens` lumps fresh
    // input together with cache-write tokens (billed at different rates).
    const copilotBreakdown = extractCopilotUsageBreakdown(json);
    if (copilotBreakdown) {
      const merged = { ...(result.usage || {}), ...copilotBreakdown };
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
      result.usage = merged;
    }

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
      result.usage = {};
      const u = json.message.usage;
      if (typeof u.input_tokens === 'number') result.usage.input_tokens = u.input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number') result.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      const cacheReadTokens = extractCacheReadTokens(u);
      if (typeof cacheReadTokens === 'number') result.usage.cache_read_input_tokens = cacheReadTokens;
      result.model = (json.message && json.message.model) || result.model;
      return result;
    }

    // Anthropic message_delta: usage at top level
    if (json.type === 'message_delta' && json.usage) {
      result.usage = {};
      if (typeof json.usage.output_tokens === 'number') result.usage.output_tokens = json.usage.output_tokens;
      return result;
    }

    // OpenAI Responses API: usage in response object on completion events
    if ((json.type === 'response.completed' || json.type === 'response.done')
      && json.response && json.response.usage && typeof json.response.usage === 'object') {
      const u = json.response.usage;
      result.usage = {};
      if (typeof u.input_tokens === 'number') result.usage.input_tokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') result.usage.output_tokens = u.output_tokens;
      if (typeof u.total_tokens === 'number') result.usage.total_tokens = u.total_tokens;
      const reasoningTokens = extractReasoningTokens(u);
      if (typeof reasoningTokens === 'number') result.usage.reasoning_tokens = reasoningTokens;
      const cacheReadTokens = extractCacheReadTokens(u);
      if (typeof cacheReadTokens === 'number') result.usage.cache_read_input_tokens = cacheReadTokens;
      result.model = json.response.model || result.model;
      return result;
    }

    // OpenAI/Copilot: usage at top level in final chunk
    if (json.usage && typeof json.usage === 'object') {
      result.usage = {};
      if (typeof json.usage.prompt_tokens === 'number') result.usage.prompt_tokens = json.usage.prompt_tokens;
      if (typeof json.usage.completion_tokens === 'number') result.usage.completion_tokens = json.usage.completion_tokens;
      if (typeof json.usage.total_tokens === 'number') result.usage.total_tokens = json.usage.total_tokens;
      const reasoningTokens = extractReasoningTokens(json.usage);
      if (typeof reasoningTokens === 'number') {
        result.usage.reasoning_tokens = reasoningTokens;
      }
      const cacheReadTokens = extractCacheReadTokens(json.usage);
      if (typeof cacheReadTokens === 'number') result.usage.cache_read_input_tokens = cacheReadTokens;
      const copilotBreakdown = extractCopilotUsageBreakdown(json);
      if (copilotBreakdown) {
        result.usage = { ...result.usage, ...copilotBreakdown };
        if (copilotBreakdown.input_tokens !== undefined) {
          // Copilot gave us a precise input split: drop the lumped prompt_tokens.
          delete result.usage.prompt_tokens;
        } else if (copilotBreakdown.cache_creation_input_tokens !== undefined
                   && typeof result.usage.prompt_tokens === 'number') {
          // cache_write present but input absent: infer input = prompt_tokens - cache_write
          // to avoid double-counting cache_write in normalizeUsage.
          result.usage.input_tokens = Math.max(0, result.usage.prompt_tokens - copilotBreakdown.cache_creation_input_tokens);
          delete result.usage.prompt_tokens;
        }
      }
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
 *   - cache_read_tokens: number (from Anthropic cache_read_input_tokens or OpenAI prompt_tokens_details.cached_tokens)
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
