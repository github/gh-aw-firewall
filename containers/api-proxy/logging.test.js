'use strict';

const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');

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
      for (const level of ['info', 'warn', 'error']) {
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
  });
});
