'use strict';

const { generateRequestId, sanitizeForLog, logRequest, logRequestShape } = require('./logging');

describe('logging', () => {
  describe('generateRequestId', () => {
    it('should return a valid UUID v4 format', () => {
      const id = generateRequestId();
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidV4Regex);
    });

    it('should return unique values on each call', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRequestId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('sanitizeForLog', () => {
    it('should strip control characters', () => {
      const input = 'hello\x00world\x1f\x7ftest';
      expect(sanitizeForLog(input)).toBe('helloworldtest');
    });

    it('should limit string length to default 200 chars', () => {
      const input = 'a'.repeat(300);
      expect(sanitizeForLog(input)).toHaveLength(200);
    });

    it('should respect custom maxLen', () => {
      const input = 'a'.repeat(100);
      expect(sanitizeForLog(input, 50)).toHaveLength(50);
    });

    it('should return empty string for non-string input', () => {
      expect(sanitizeForLog(null)).toBe('');
      expect(sanitizeForLog(undefined)).toBe('');
      expect(sanitizeForLog(123)).toBe('');
      expect(sanitizeForLog({})).toBe('');
    });

    it('should pass through normal strings unchanged', () => {
      expect(sanitizeForLog('hello world')).toBe('hello world');
    });

    it('should strip newlines and tabs', () => {
      expect(sanitizeForLog('line1\nline2\ttab')).toBe('line1line2tab');
    });
  });

  describe('logRequest', () => {
    let stdoutSpy;

    beforeEach(() => {
      stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
    });

    it('should output valid JSON to stdout', () => {
      logRequest('info', 'test_event');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include timestamp in ISO 8601 format', () => {
      logRequest('info', 'test_event');
      const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
      // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should include level and event', () => {
      logRequest('warn', 'request_error');
      const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('warn');
      expect(parsed.event).toBe('request_error');
    });

    it('should merge additional fields', () => {
      logRequest('info', 'request_start', { request_id: 'abc-123', provider: 'openai' });
      const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
      expect(parsed.request_id).toBe('abc-123');
      expect(parsed.provider).toBe('openai');
    });

    it('redacts the sensitive OpenAI target from every logged string field', () => {
      const previous = process.env.AWF_SENSITIVE_OPENAI_TARGET;
      process.env.AWF_SENSITIVE_OPENAI_TARGET = ['lb', 'secret', 'example', 'com'].join('.');
      try {
        logRequest('info', 'request_complete', {
          upstream_host: 'LB.Secret.Example.Com',
          message: 'Custom target lb.secret.example.com; validation skipped',
        });
        const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(JSON.stringify(parsed)).not.toContain('secret.example.com');
        expect(parsed.upstream_host).toBe('[REDACTED]');
      } finally {
        if (previous === undefined) delete process.env.AWF_SENSITIVE_OPENAI_TARGET;
        else process.env.AWF_SENSITIVE_OPENAI_TARGET = previous;
      }
    });

    it('should not include undefined fields', () => {
      logRequest('info', 'test', { a: undefined, b: 'value' });
      const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
      expect(parsed.b).toBe('value');
      expect('a' in parsed).toBe(false);
    });

    it('should end line with newline character', () => {
      logRequest('info', 'test');
      const output = stdoutSpy.mock.calls[0][0];
      expect(output.endsWith('\n')).toBe(true);
    });

    it('should support all log levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        stdoutSpy.mockClear();
        logRequest(level, 'test');
        const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(parsed.level).toBe(level);
      }
    });

    it('should support all event types', () => {
      const events = ['request_start', 'request_complete', 'request_error', 'startup'];
      for (const event of events) {
        stdoutSpy.mockClear();
        logRequest('info', event);
        const parsed = JSON.parse(stdoutSpy.mock.calls[0][0]);
        expect(parsed.event).toBe(event);
      }
    });

    describe('logRequestShape', () => {
      let stdoutSpy;

      beforeEach(() => {
        stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      });

      afterEach(() => {
        stdoutSpy.mockRestore();
      });

      it.each(['copilot', 'openai'])('counts %s Responses message and tool-output parts without payloads', provider => {
        const body = Buffer.from(JSON.stringify({
          model: 'private-model',
          instructions: 'private instructions',
          input: [
            { role: 'user', content: [
              { type: 'input_text', text: 'private prompt' },
              { type: 'input_image', image_url: 'data:image/png;base64,cHJpdmF0ZQ==' },
            ] },
            { type: 'function_call', name: 'private tool', arguments: 'private arguments' },
            { type: 'function_call_output', call_id: 'private call', output: [
              { type: 'input_text', text: 'private result' },
              { type: 'input_image', image_url: 'https://private.example/image.png' },
            ] },
          ],
        }));
        const original = Buffer.from(body);
        logRequestShape(body, provider, 'req-shape', 'inbound');
        const output = stdoutSpy.mock.calls[0][0];
        expect(JSON.parse(output)).toEqual({
          timestamp: expect.any(String), level: 'debug', event: 'request_shape',
          request_id: 'req-shape', provider, stage: 'inbound', body_bytes: body.length,
          input_item_types: { message: 1, function_call: 1, function_call_output: 1 },
          content_part_types: { input_text: 1, input_image: 1 },
          tool_output_part_types: { input_text: 1, input_image: 1 },
        });
        expect(output).not.toMatch(/private|cHJpdmF0ZQ==|image_url|arguments|instructions/);
        expect(body).toEqual(original);
      });

      it('distinguishes string tool outputs and supports Chat Completions content', () => {
        logRequestShape(Buffer.from(JSON.stringify({
          input: [{ type: 'function_call_output', output: 'Viewed image file successfully.' }],
        })), 'copilot', 'req-text', 'inbound');
        expect(JSON.parse(stdoutSpy.mock.calls[0][0]).tool_output_part_types).toEqual({ text: 1 });
        expect(stdoutSpy.mock.calls[0][0]).not.toContain('Viewed image');
        logRequestShape(Buffer.from(JSON.stringify({
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'private' }, { type: 'image_url', image_url: { url: 'private' } },
          ] }],
        })), 'copilot', 'req-chat', 'upstream');
        expect(JSON.parse(stdoutSpy.mock.calls[1][0]).content_part_types).toEqual({ text: 1, image_url: 1 });
      });

      it('buckets unknown or malformed types without logging arbitrary labels', () => {
        logRequestShape(Buffer.from(JSON.stringify({
          input: [
            { type: 'private\nlabel', content: [null, { type: '__proto__' }, { type: 'private secret' }] },
            null,
          ],
        })), 'copilot', 'req-unknown', 'inbound');
        expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toMatchObject({
          input_item_types: { unknown: 2 }, content_part_types: { unknown: 3 },
        });
        expect(stdoutSpy.mock.calls[0][0]).not.toMatch(/private|__proto__/);
      });

      it.each(['invalid JSON', 'null', '[]'])('handles unrecognized body %s without throwing', value => {
        logRequestShape(Buffer.from(value), 'copilot', 'req-invalid', 'inbound');
        expect(JSON.parse(stdoutSpy.mock.calls[0][0])).toMatchObject({ body_format: 'unrecognized' });
        expect(stdoutSpy.mock.calls[0][0]).not.toContain(value);
      });

      it('skips empty bodies and other providers', () => {
        logRequestShape(Buffer.alloc(0), 'copilot', 'req-empty', 'inbound');
        logRequestShape(Buffer.from('{}'), 'anthropic', 'req-other', 'inbound');
        expect(stdoutSpy).not.toHaveBeenCalled();
      });
    });
  });
});
