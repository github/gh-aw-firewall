'use strict';

/**
 * Tests for blocked-request-diagnostics.js
 *
 * Covers:
 *  - getCaptureMode() env-var parsing
 *  - analyzeRequestBody() shape extraction in all capture modes
 *  - analyzeMessages() message/tool-result counting
 *  - writeBlockedRequestDiag() JSONL persistence
 *  - graceful handling of malformed bodies and disabled mode
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function withIsolatedModule(envOverrides, fn) {
  // Save and apply env
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  let mod;
  jest.isolateModules(() => {
    mod = require('./blocked-request-diagnostics');
  });

  try {
    return fn(mod);
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function readDiagLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// ── getCaptureMode() ──────────────────────────────────────────────────────────

describe('getCaptureMode()', () => {
  afterEach(() => {
    delete process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS;
  });

  it('returns false when env var is not set', () => {
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe(false);
    });
  });

  it('returns false for explicit "false"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'false';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe(false);
    });
  });

  it('returns false for "0"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = '0';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe(false);
    });
  });

  it('returns "summary" for "summary"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'summary';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe('summary');
    });
  });

  it('returns "summary" for "true"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'true';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe('summary');
    });
  });

  it('returns "summary" for "1"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = '1';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe('summary');
    });
  });

  it('returns "redacted" for "redacted"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'redacted';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe('redacted');
    });
  });

  it('returns "full" for "full"', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'full';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe('full');
    });
  });

  it('returns false for unrecognised value', () => {
    process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS = 'verbose';
    jest.isolateModules(() => {
      const { getCaptureMode } = require('./blocked-request-diagnostics');
      expect(getCaptureMode()).toBe(false);
    });
  });
});

// ── analyzeRequestBody() ──────────────────────────────────────────────────────

describe('analyzeRequestBody()', () => {
  let analyzeRequestBody;

  beforeAll(() => {
    jest.isolateModules(() => {
      ({ analyzeRequestBody } = require('./blocked-request-diagnostics'));
    });
  });

  it('returns body_bytes=0 and null sha256 for empty buffer', () => {
    const result = analyzeRequestBody(Buffer.alloc(0), 'summary');
    expect(result).toEqual({ body_bytes: 0, body_sha256: null });
  });

  it('returns body_bytes and sha256 for non-JSON body', () => {
    const body = Buffer.from('not json');
    const result = analyzeRequestBody(body, 'summary');
    expect(result.body_bytes).toBe(8);
    expect(result.body_sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(result.parse_error).toBe(true);
  });

  it('extracts model and message_count in summary mode', () => {
    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'summary');

    expect(result.model).toBe('gpt-4o');
    expect(result.message_count).toBe(2);
    expect(result.tool_result_count).toBe(0);
    expect(result.message_sizes).toHaveLength(2);
    expect(result.message_sizes[0]).toMatchObject({
      role: 'user',
      content_type: 'text',
      chars: 5,
      bytes: 5,
    });
    expect(result.body_sha256).toMatch(/^[0-9a-f]{16}$/);
    // Summary mode: no content_preview
    expect(result.message_sizes[0].content_preview).toBeUndefined();
  });

  it('includes content_preview in redacted mode', () => {
    const payload = {
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'Secret prompt' }],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'redacted');

    expect(result.message_sizes[0].content_preview).toBe('Secret prompt');
  });

  it('includes content_preview in full mode', () => {
    const payload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Full content' }],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'full');

    expect(result.message_sizes[0].content_preview).toBe('Full content');
    expect(result.body_full).toBeDefined();
  });

  it('counts tool_result blocks (Anthropic format)', () => {
    const payload = {
      model: 'claude-opus-4.7',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'result text' },
            { type: 'text', text: 'Check the above' },
          ],
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'summary');

    expect(result.tool_result_count).toBe(1);
    expect(result.message_sizes[0].tool_blocks).toBe(1);
  });

  it('counts tool role messages (OpenAI format)', () => {
    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Use the tool' },
        { role: 'tool', content: 'tool result here' },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'summary');

    expect(result.tool_result_count).toBe(1);
  });

  it('sets streaming=true when stream:true in body', () => {
    const payload = { model: 'gpt-4o', stream: true, messages: [] };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'summary');

    expect(result.streaming).toBe(true);
  });

  it('truncates body_full to AWF_MAX_BLOCKED_CAPTURE_BYTES', () => {
    const original = process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES;
    process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES = '10';
    try {
      const payload = { model: 'gpt-4o', messages: [{ role: 'user', content: 'abcdefghij1234567890' }] };
      const body = Buffer.from(JSON.stringify(payload));
      jest.isolateModules(() => {
        const { analyzeRequestBody: analyze } = require('./blocked-request-diagnostics');
        const result = analyze(body, 'full');
        expect(result.body_full.length).toBeLessThanOrEqual(10);
      });
    } finally {
      if (original === undefined) {
        delete process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES;
      } else {
        process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES = original;
      }
    }
  });

  it('handles structured content blocks (Anthropic array content)', () => {
    const payload = {
      model: 'claude-opus-4.7',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the image' },
            { type: 'image', source: { type: 'base64', data: 'aGVsbG8=' } },
          ],
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const result = analyzeRequestBody(body, 'summary');

    expect(result.message_sizes[0].content_type).toContain('text');
    expect(result.message_sizes[0].chars).toBeGreaterThan(0);
    expect(result.message_sizes[0].bytes).toBeGreaterThan(0);
  });
});

// ── writeBlockedRequestDiag() ─────────────────────────────────────────────────

describe('writeBlockedRequestDiag()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-blocked-diag-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS;
    delete process.env.AWF_TOKEN_LOG_DIR;
  });

  it('does not write anything when capture mode is disabled', () => {
    delete process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS;

    withIsolatedModule({ AWF_TOKEN_LOG_DIR: tmpDir }, (mod) => {
      mod.writeBlockedRequestDiag({
        requestId: 'req-1',
        provider: 'openai',
        path: '/v1/chat/completions',
        guardType: 'effective_tokens_limit_exceeded',
        guardLogFields: { total_effective_tokens: 100, max_effective_tokens: 50 },
        body: Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] })),
        inboundBytes: 40,
      });
      mod.testHelpers.resetDiagStream();
    });

    const diagFile = path.join(tmpDir, 'blocked-request-diag.jsonl');
    expect(fs.existsSync(diagFile)).toBe(false);
  });

  it('writes a JSONL record in summary mode', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'summary' },
      (mod) => {
        const body = Buffer.from(JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        }));

        mod.writeBlockedRequestDiag({
          requestId: 'req-abc',
          provider: 'openai',
          path: '/v1/chat/completions',
          guardType: 'effective_tokens_limit_exceeded',
          guardLogFields: { total_effective_tokens: 1500, max_effective_tokens: 1000 },
          body,
          inboundBytes: body.length,
        });

        // Flush stream before reading
        setImmediate(() => {
          mod.closeBlockedRequestDiagStream().then(() => {
            const diagFile = path.join(tmpDir, 'blocked-request-diag.jsonl');
            const lines = readDiagLines(diagFile);

            expect(lines).toHaveLength(1);
            const rec = lines[0];
            expect(rec._schema).toMatch(/^blocked-request-diag\/v/);
            expect(rec.event).toBe('blocked_request_diag');
            expect(rec.capture_mode).toBe('summary');
            expect(rec.request_id).toBe('req-abc');
            expect(rec.provider).toBe('openai');
            expect(rec.path).toBe('/v1/chat/completions');
            expect(rec.guard_type).toBe('effective_tokens_limit_exceeded');
            expect(rec.guard_totals).toEqual({
              total_effective_tokens: 1500,
              max_effective_tokens: 1000,
            });
            expect(rec.model).toBe('gpt-4o');
            expect(rec.message_count).toBe(1);
            expect(rec.tool_result_count).toBe(0);
            expect(rec.body_bytes).toBe(body.length);
            expect(rec.body_sha256).toMatch(/^[0-9a-f]{16}$/);
            expect(rec.body_transformed).toBe(false);
            expect(rec.inbound_bytes).toBe(body.length);
            // Summary mode: no content_preview
            expect(rec.message_sizes[0].content_preview).toBeUndefined();
            done();
          });
        });
      },
    );
  });

  it('writes content_preview in redacted mode', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'redacted' },
      (mod) => {
        const body = Buffer.from(JSON.stringify({
          model: 'claude-opus-4.7',
          messages: [{ role: 'user', content: 'This is the user prompt' }],
        }));

        mod.writeBlockedRequestDiag({
          requestId: 'req-redacted',
          provider: 'anthropic',
          path: '/v1/messages',
          guardType: 'ai_credits_limit_exceeded',
          guardLogFields: { total_ai_credits: 10.5, max_ai_credits: 10.0 },
          body,
          inboundBytes: body.length,
        });

        mod.closeBlockedRequestDiagStream().then(() => {
          const lines = readDiagLines(path.join(tmpDir, 'blocked-request-diag.jsonl'));
          expect(lines).toHaveLength(1);
          const rec = lines[0];
          expect(rec.capture_mode).toBe('redacted');
          expect(rec.message_sizes[0].content_preview).toBe('This is the user prompt');
          done();
        });
      },
    );
  });

  it('records body_transformed=true when body was changed by a transform', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'summary' },
      (mod) => {
        const originalBody = Buffer.from('{"model":"gpt-4o","messages":[]}');
        const transformedBody = Buffer.from('{"model":"gpt-4o","messages":[],"stream_options":{"include_usage":true}}');

        mod.writeBlockedRequestDiag({
          requestId: 'req-transform',
          provider: 'openai',
          path: '/v1/chat/completions',
          guardType: 'max_runs_exceeded',
          guardLogFields: { invocation_count: 5, max_runs: 5 },
          body: transformedBody,
          inboundBytes: originalBody.length,
        });

        mod.closeBlockedRequestDiagStream().then(() => {
          const lines = readDiagLines(path.join(tmpDir, 'blocked-request-diag.jsonl'));
          expect(lines[0].body_transformed).toBe(true);
          expect(lines[0].inbound_bytes).toBe(originalBody.length);
          done();
        });
      },
    );
  });

  it('writes multiple records to the same file', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'summary' },
      (mod) => {
        const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] }));
        const writeOpts = {
          provider: 'openai',
          path: '/v1/chat/completions',
          guardType: 'effective_tokens_limit_exceeded',
          guardLogFields: {},
          body,
          inboundBytes: body.length,
        };

        mod.writeBlockedRequestDiag({ ...writeOpts, requestId: 'req-1' });
        mod.writeBlockedRequestDiag({ ...writeOpts, requestId: 'req-2' });
        mod.writeBlockedRequestDiag({ ...writeOpts, requestId: 'req-3' });

        mod.closeBlockedRequestDiagStream().then(() => {
          const lines = readDiagLines(path.join(tmpDir, 'blocked-request-diag.jsonl'));
          expect(lines).toHaveLength(3);
          expect(lines.map(l => l.request_id)).toEqual(['req-1', 'req-2', 'req-3']);
          done();
        });
      },
    );
  });

  it('does not include content_preview in summary mode', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'summary' },
      (mod) => {
        const body = Buffer.from(JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Top secret system prompt' }],
        }));

        mod.writeBlockedRequestDiag({
          requestId: 'req-safe',
          provider: 'openai',
          path: '/v1/chat/completions',
          guardType: 'effective_tokens_limit_exceeded',
          guardLogFields: {},
          body,
          inboundBytes: body.length,
        });

        mod.closeBlockedRequestDiagStream().then(() => {
          const lines = readDiagLines(path.join(tmpDir, 'blocked-request-diag.jsonl'));
          const rec = lines[0];
          // No content should appear in summary mode
          for (const msg of rec.message_sizes) {
            expect(msg.content_preview).toBeUndefined();
          }
          // Body full should not appear in summary mode
          expect(rec.body_full).toBeUndefined();
          done();
        });
      },
    );
  });

  it('handles malformed JSON body gracefully', (done) => {
    withIsolatedModule(
      { AWF_TOKEN_LOG_DIR: tmpDir, AWF_CAPTURE_BLOCKED_LLM_REQUESTS: 'summary' },
      (mod) => {
        const body = Buffer.from('not valid json {{{');

        mod.writeBlockedRequestDiag({
          requestId: 'req-bad-body',
          provider: 'openai',
          path: '/v1/chat/completions',
          guardType: 'effective_tokens_limit_exceeded',
          guardLogFields: {},
          body,
          inboundBytes: body.length,
        });

        mod.closeBlockedRequestDiagStream().then(() => {
          const lines = readDiagLines(path.join(tmpDir, 'blocked-request-diag.jsonl'));
          expect(lines).toHaveLength(1);
          expect(lines[0].parse_error).toBe(true);
          expect(lines[0].body_bytes).toBe(body.length);
          done();
        });
      },
    );
  });
});

// ── closeBlockedRequestDiagStream() ──────────────────────────────────────────

describe('closeBlockedRequestDiagStream()', () => {
  it('resolves even when no stream has been opened', async () => {
    let mod;
    jest.isolateModules(() => {
      mod = require('./blocked-request-diagnostics');
    });
    await expect(mod.closeBlockedRequestDiagStream()).resolves.toBeUndefined();
  });
});
