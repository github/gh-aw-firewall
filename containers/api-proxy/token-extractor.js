/**
 * Token Extractor — a Transform stream that observes LLM API response data
 * flowing through and extracts token usage counts.
 *
 * Data passes through unchanged (client sees identical response).
 * On stream end, emits a 'tokens' event with { input, output, total }.
 *
 * Handles four response formats:
 * 1. Anthropic non-streaming (JSON with usage.input_tokens / output_tokens)
 * 2. Anthropic SSE (message_start → input_tokens, message_delta → output_tokens)
 * 3. OpenAI non-streaming (JSON with usage.prompt_tokens / completion_tokens)
 * 4. OpenAI SSE (usage field in chunk before [DONE])
 *
 * Zero external dependencies.
 */

'use strict';

const { Transform } = require('stream');

const ZERO_TOKENS = { input: 0, output: 0, total: 0 };

/**
 * Extract token counts from a parsed Anthropic JSON response.
 */
function extractAnthropic(body) {
  if (!body || typeof body !== 'object') return null;
  const usage = body.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return { input, output, total: input + output };
}

/**
 * Extract token counts from a parsed OpenAI JSON response.
 * Also used for Copilot (same format).
 */
function extractOpenAI(body) {
  if (!body || typeof body !== 'object') return null;
  const usage = body.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output;
  return { input, output, total };
}

/**
 * Try to parse a JSON string, returning null on failure.
 */
function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

class TokenExtractor extends Transform {
  /**
   * @param {Object} opts
   * @param {string} opts.provider - 'anthropic' | 'openai' | 'copilot'
   * @param {boolean} opts.isSSE - whether Content-Type indicates SSE
   * @param {boolean} opts.skipExtraction - skip extraction (e.g. compressed)
   */
  constructor({ provider, isSSE, skipExtraction }) {
    super();
    this._provider = provider;
    this._isSSE = isSSE;
    this._skipExtraction = skipExtraction;

    if (isSSE) {
      // SSE mode: parse line-by-line, track tokens incrementally
      this._sseInput = 0;
      this._sseOutput = 0;
      this._sseTotal = 0;
      this._sseLineBuf = ''; // buffer for incomplete lines across chunks
    } else {
      // Non-streaming mode: buffer the full body
      this._chunks = [];
    }
  }

  _transform(chunk, encoding, callback) {
    // Always pass data through unchanged
    if (!this._skipExtraction) {
      if (this._isSSE) {
        this._processSSEChunk(chunk);
      } else {
        this._chunks.push(chunk);
      }
    }
    callback(null, chunk);
  }

  _flush(callback) {
    try {
      if (this._skipExtraction) {
        this.emit('tokens', { ...ZERO_TOKENS });
        callback();
        return;
      }

      if (this._isSSE) {
        // Process any remaining data in the line buffer
        if (this._sseLineBuf.trim()) {
          this._processSSELine(this._sseLineBuf);
        }
        const total = this._sseTotal || (this._sseInput + this._sseOutput);
        this.emit('tokens', {
          input: this._sseInput,
          output: this._sseOutput,
          total,
        });
      } else {
        this._extractFromBuffer();
      }
    } catch {
      this.emit('tokens', { ...ZERO_TOKENS });
    }
    callback();
  }

  /**
   * Process an SSE chunk, splitting into lines and extracting token data.
   */
  _processSSEChunk(chunk) {
    const text = this._sseLineBuf + chunk.toString('utf8');
    const lines = text.split('\n');
    // Last element may be incomplete — keep it in the buffer
    this._sseLineBuf = lines.pop();

    for (const line of lines) {
      this._processSSELine(line);
    }
  }

  /**
   * Process a single SSE line, looking for data: prefixed JSON with usage info.
   */
  _processSSELine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    const obj = safeParse(payload);
    if (!obj) return;

    if (this._provider === 'anthropic') {
      this._extractAnthropicSSE(obj);
    } else {
      // openai / copilot
      this._extractOpenAISSE(obj);
    }
  }

  /**
   * Anthropic SSE: input from message_start, output from message_delta.
   */
  _extractAnthropicSSE(obj) {
    if (obj.type === 'message_start' && obj.message && obj.message.usage) {
      const u = obj.message.usage;
      if (typeof u.input_tokens === 'number') {
        this._sseInput = u.input_tokens;
      }
    }
    if (obj.type === 'message_delta' && obj.usage) {
      const u = obj.usage;
      if (typeof u.output_tokens === 'number') {
        this._sseOutput = u.output_tokens;
      }
    }
  }

  /**
   * OpenAI SSE: usage field appears in the final chunk before [DONE].
   */
  _extractOpenAISSE(obj) {
    if (obj.usage && typeof obj.usage === 'object') {
      const u = obj.usage;
      if (typeof u.prompt_tokens === 'number') this._sseInput = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') this._sseOutput = u.completion_tokens;
      if (typeof u.total_tokens === 'number') this._sseTotal = u.total_tokens;
    }
  }

  /**
   * Parse buffered non-streaming response and extract tokens.
   */
  _extractFromBuffer() {
    if (!this._chunks.length) {
      this.emit('tokens', { ...ZERO_TOKENS });
      return;
    }

    const body = Buffer.concat(this._chunks).toString('utf8');
    const parsed = safeParse(body);
    if (!parsed) {
      this.emit('tokens', { ...ZERO_TOKENS });
      return;
    }

    let result = null;
    if (this._provider === 'anthropic') {
      result = extractAnthropic(parsed);
    } else {
      // openai / copilot
      result = extractOpenAI(parsed);
    }

    this.emit('tokens', result || { ...ZERO_TOKENS });
  }
}

/**
 * Factory function to create a TokenExtractor stream.
 *
 * @param {Object} opts
 * @param {string} opts.provider - 'anthropic' | 'openai' | 'copilot'
 * @param {string} opts.contentType - response Content-Type header value
 * @param {string} [opts.contentEncoding] - response Content-Encoding header value
 * @returns {TokenExtractor}
 */
function createTokenExtractor({ provider, contentType, contentEncoding }) {
  const isSSE = typeof contentType === 'string' && contentType.includes('text/event-stream');
  const enc = (contentEncoding || '').toLowerCase();
  const skipExtraction = enc === 'gzip' || enc === 'br' || enc === 'deflate';

  return new TokenExtractor({ provider, isSSE, skipExtraction });
}

module.exports = { createTokenExtractor, TokenExtractor };
