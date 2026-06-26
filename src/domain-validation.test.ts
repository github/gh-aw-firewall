/**
 * Tests for domain-validation.ts
 *
 * validateDomainOrPattern() is the Squid-injection prevention path for
 * --allow-domains and --allow-urls. Security-critical: prevents malicious
 * input from escaping into generated Squid configuration.
 */

import { validateDomainOrPattern, SQUID_DANGEROUS_CHARS } from './domain-validation';

describe('validateDomainOrPattern', () => {
  // ─── Valid inputs ────────────────────────────────────────────────────────────

  describe('valid domains and patterns', () => {
    it('accepts a plain domain', () => {
      expect(() => validateDomainOrPattern('github.com')).not.toThrow();
    });

    it('accepts a subdomain', () => {
      expect(() => validateDomainOrPattern('api.github.com')).not.toThrow();
    });

    it('accepts a wildcard subdomain pattern', () => {
      expect(() => validateDomainOrPattern('*.github.com')).not.toThrow();
    });

    it('accepts a domain with protocol prefix (https://)', () => {
      expect(() => validateDomainOrPattern('https://github.com')).not.toThrow();
    });

    it('accepts a domain with protocol prefix (http://)', () => {
      expect(() => validateDomainOrPattern('http://example.com')).not.toThrow();
    });

    it('accepts a single-segment domain', () => {
      expect(() => validateDomainOrPattern('localhost')).not.toThrow();
    });

    it('accepts a domain with hyphens', () => {
      expect(() => validateDomainOrPattern('my-service.example.com')).not.toThrow();
    });

    it('accepts IP-like strings', () => {
      expect(() => validateDomainOrPattern('192.168.1.10')).not.toThrow();
    });
  });

  // ─── Empty input ─────────────────────────────────────────────────────────────

  describe('empty input', () => {
    it('throws for empty string', () => {
      expect(() => validateDomainOrPattern('')).toThrow('Domain cannot be empty');
    });

    it('throws for whitespace-only string', () => {
      expect(() => validateDomainOrPattern('   ')).toThrow('Domain cannot be empty');
    });

    it('throws for tab-only string', () => {
      expect(() => validateDomainOrPattern('\t')).toThrow('Domain cannot be empty');
    });
  });

  // ─── Dangerous characters (Squid injection prevention) ───────────────────────

  describe('dangerous characters', () => {
    it('throws for domain containing a space', () => {
      expect(() => validateDomainOrPattern('github .com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a tab character', () => {
      expect(() => validateDomainOrPattern('github\t.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a newline', () => {
      expect(() => validateDomainOrPattern('github\n.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a carriage return', () => {
      expect(() => validateDomainOrPattern('github\r.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing double quotes', () => {
      expect(() => validateDomainOrPattern('github".com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing single quotes', () => {
      expect(() => validateDomainOrPattern("github'.com")).toThrow(/invalid character/i);
    });

    it('throws for domain containing a backtick', () => {
      expect(() => validateDomainOrPattern('github`.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a semicolon', () => {
      expect(() => validateDomainOrPattern('github;.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a hash character', () => {
      expect(() => validateDomainOrPattern('github#.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a backslash', () => {
      expect(() => validateDomainOrPattern('github\\.com')).toThrow(/invalid character/i);
    });

    it('throws for domain containing a null byte', () => {
      expect(() => validateDomainOrPattern('github\0.com')).toThrow(/invalid character/i);
    });

    it('includes character description in error message for control characters', () => {
      try {
        validateDomainOrPattern('github\0.com');
        fail('should have thrown');
      } catch (e: unknown) {
        expect((e as Error).message).toMatch(/U\+/i);
      }
    });

    it('includes character representation in error message for printable dangerous chars', () => {
      try {
        validateDomainOrPattern('github#.com');
        fail('should have thrown');
      } catch (e: unknown) {
        expect((e as Error).message).toMatch(/'#'/);
      }
    });
  });

  // ─── Over-broad wildcard patterns ────────────────────────────────────────────

  describe('over-broad wildcard patterns', () => {
    it('rejects bare asterisk (*)', () => {
      expect(() => validateDomainOrPattern('*')).toThrow(/matches all domains/i);
    });

    it('rejects star-dot-star (*.*)', () => {
      expect(() => validateDomainOrPattern('*.*')).toThrow(/too broad/i);
    });

    it('rejects triple-wildcard (*.*.*)', () => {
      expect(() => validateDomainOrPattern('*.*.*')).toThrow(/too broad/i);
    });

    it('rejects any pattern composed only of * and .', () => {
      // purely wildcard+dot patterns like *.* are caught in checkOverBroadPattern
      expect(() => validateDomainOrPattern('*.*.*')).toThrow(/too broad/);
    });
  });

  // ─── Structural validity ──────────────────────────────────────────────────────

  describe('structural validity', () => {
    it('rejects double dots', () => {
      expect(() => validateDomainOrPattern('foo..bar.com')).toThrow(/double dots/i);
    });

    it('rejects lone dot', () => {
      expect(() => validateDomainOrPattern('.')).toThrow(/just a dot/i);
    });

    it('rejects too many wildcard segments (*.*.com)', () => {
      expect(() => validateDomainOrPattern('*.*.com')).toThrow(/too many wildcard segments/i);
    });

    it('accepts a single wildcard in multi-segment pattern (*.github.com)', () => {
      expect(() => validateDomainOrPattern('*.github.com')).not.toThrow();
    });

    it('accepts two wildcards when there are enough non-wildcard segments', () => {
      // *.api.*.github.com → 2 wildcards out of 5 segments, not >= totalSegments-1
      expect(() => validateDomainOrPattern('*.api.*.github.com')).not.toThrow();
    });
  });
});

// ─── SQUID_DANGEROUS_CHARS export ────────────────────────────────────────────

describe('SQUID_DANGEROUS_CHARS', () => {
  it('is exported and is a RegExp', () => {
    expect(SQUID_DANGEROUS_CHARS).toBeInstanceOf(RegExp);
  });

  it('matches whitespace characters', () => {
    expect(SQUID_DANGEROUS_CHARS.test(' ')).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test('\t')).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test('\n')).toBe(true);
  });

  it('matches quote and injection characters', () => {
    expect(SQUID_DANGEROUS_CHARS.test('"')).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test("'")).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test('`')).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test(';')).toBe(true);
    expect(SQUID_DANGEROUS_CHARS.test('#')).toBe(true);
  });

  it('does NOT match safe domain characters', () => {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789.-_*') {
      expect(SQUID_DANGEROUS_CHARS.test(ch)).toBe(false);
    }
  });

  it('does NOT match backslash (URL regex patterns legitimately use it)', () => {
    expect(SQUID_DANGEROUS_CHARS.test('\\')).toBe(false);
  });
});
