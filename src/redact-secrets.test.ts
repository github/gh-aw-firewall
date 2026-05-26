import { redactSecrets } from './redact-secrets';

describe('redactSecrets', () => {
  describe('when given a string without secrets', () => {
    it('should return the string unchanged', () => {
      expect(redactSecrets('hello world')).toBe('hello world');
    });

    it('should return empty string unchanged', () => {
      expect(redactSecrets('')).toBe('');
    });

    it('should not redact ordinary environment variables', () => {
      expect(redactSecrets('HOME=/home/user PATH=/usr/bin')).toBe('HOME=/home/user PATH=/usr/bin');
    });
  });

  describe('Authorization header redaction', () => {
    it('should redact Bearer tokens', () => {
      expect(redactSecrets('Authorization: Bearer abc123token')).toBe(
        'Authorization: Bearer ***REDACTED***'
      );
    });

    it('should redact Bearer tokens case-insensitively', () => {
      expect(redactSecrets('authorization: bearer MyToken123')).toBe(
        'authorization: bearer ***REDACTED***'
      );
    });

    it('should redact non-Bearer Authorization headers', () => {
      expect(redactSecrets('Authorization: mysecrettoken')).toBe(
        'Authorization: ***REDACTED***'
      );
    });

    it('should redact the auth type token from non-Bearer Authorization headers', () => {
      // Non-Bearer regex captures only the first token (e.g., "Basic"), not the value after it.
      // This means "Authorization: Basic dXNlcjpwYXNz" → "Authorization: ***REDACTED*** dXNlcjpwYXNz"
      // The "Basic" keyword is redacted but the base64 value remains. This is a known limitation.
      const result = redactSecrets('Authorization: Basic dXNlcjpwYXNz');
      expect(result).toBe('Authorization: ***REDACTED*** dXNlcjpwYXNz');
    });

    it('should redact Authorization header in a longer string', () => {
      const input = 'curl -H "Authorization: Bearer tok123" https://api.example.com';
      const result = redactSecrets(input);
      expect(result).toContain('***REDACTED***');
      expect(result).not.toContain('tok123');
    });
  });

  describe('environment variable redaction', () => {
    it('should redact TOKEN variables', () => {
      expect(redactSecrets('GITHUB_TOKEN=ghp_abcdef123456')).toBe(
        'GITHUB_TOKEN=***REDACTED***'
      );
    });

    it('should redact SECRET variables', () => {
      expect(redactSecrets('MY_SECRET=supersecret')).toBe(
        'MY_SECRET=***REDACTED***'
      );
    });

    it('should redact PASSWORD variables', () => {
      expect(redactSecrets('DB_PASSWORD=hunter2')).toBe(
        'DB_PASSWORD=***REDACTED***'
      );
    });

    it('should redact KEY variables', () => {
      expect(redactSecrets('API_KEY=abc123xyz')).toBe(
        'API_KEY=***REDACTED***'
      );
    });

    it('should redact AUTH variables', () => {
      expect(redactSecrets('BASIC_AUTH=user:pass')).toBe(
        'BASIC_AUTH=***REDACTED***'
      );
    });

    it('should redact ACCESS_TOKEN variables', () => {
      expect(redactSecrets('ACCESS_TOKEN=secret123')).toBe(
        'ACCESS_TOKEN=***REDACTED***'
      );
    });

    it('should redact variables case-insensitively', () => {
      expect(redactSecrets('api_key=myvalue')).toBe('api_key=***REDACTED***');
    });

    it('should redact multiple env vars in one string', () => {
      const input = 'GITHUB_TOKEN=tok1 ANTHROPIC_API_KEY=tok2 HOME=/home/user';
      const result = redactSecrets(input);
      expect(result).not.toContain('tok1');
      expect(result).not.toContain('tok2');
      expect(result).toContain('HOME=/home/user');
    });
  });

  describe('GitHub token redaction', () => {
    it('should redact ghp_ tokens', () => {
      const token = 'ghp_' + 'a'.repeat(36);
      expect(redactSecrets(token)).toBe('***REDACTED***');
    });

    it('should redact gho_ tokens (OAuth)', () => {
      const token = 'gho_' + 'a'.repeat(36);
      expect(redactSecrets(token)).toBe('***REDACTED***');
    });

    it('should redact ghu_ tokens (user-to-server)', () => {
      const token = 'ghu_' + 'a'.repeat(36);
      expect(redactSecrets(token)).toBe('***REDACTED***');
    });

    it('should redact ghs_ tokens (server-to-server)', () => {
      const token = 'ghs_' + 'a'.repeat(36);
      expect(redactSecrets(token)).toBe('***REDACTED***');
    });

    it('should redact ghr_ tokens (refresh)', () => {
      const token = 'ghr_' + 'a'.repeat(36);
      expect(redactSecrets(token)).toBe('***REDACTED***');
    });

    it('should not redact short gh_ prefixed strings that are not tokens', () => {
      // Token pattern requires 36+ chars after prefix
      const shortString = 'ghp_short';
      expect(redactSecrets(shortString)).toBe('ghp_short');
    });

    it('should redact GitHub token embedded in a longer string', () => {
      const token = 'ghp_' + 'x'.repeat(36);
      const input = `GITHUB_TOKEN=${token} some other text`;
      const result = redactSecrets(input);
      expect(result).not.toContain(token);
    });
  });

  describe('security edge cases', () => {
    it('should handle multiple secrets in one command', () => {
      const token = 'ghp_' + 'z'.repeat(36);
      const input = `Authorization: Bearer mytoken GITHUB_TOKEN=${token}`;
      const result = redactSecrets(input);
      expect(result).not.toContain('mytoken');
      expect(result).not.toContain(token);
    });

    it('should not alter non-secret content around secrets', () => {
      const result = redactSecrets('echo hello && GITHUB_TOKEN=secret && echo world');
      expect(result).toContain('echo hello');
      expect(result).toContain('echo world');
      expect(result).not.toContain('secret');
    });

    it('should handle strings with only whitespace', () => {
      expect(redactSecrets('   ')).toBe('   ');
    });
  });
});
