/**
 * Tests for domain-matchers.ts
 *
 * Security-critical module: parses domain lists and matches domains
 * against wildcard patterns with protocol-awareness.
 */

import {
  parseDomainList,
  isDomainMatchedByPattern,
  parseUrlPatterns,
} from './domain-matchers';

// ─── parseDomainList ──────────────────────────────────────────────────────────

describe('parseDomainList', () => {
  describe('plain domains', () => {
    it('returns a plain domain entry for a simple domain', () => {
      const { plainDomains, patterns } = parseDomainList(['github.com']);
      expect(plainDomains).toHaveLength(1);
      expect(plainDomains[0].domain).toBe('github.com');
      expect(patterns).toHaveLength(0);
    });

    it('strips protocol prefix and records it', () => {
      const { plainDomains } = parseDomainList(['https://github.com']);
      expect(plainDomains[0].domain).toBe('github.com');
      expect(plainDomains[0].protocol).toBe('https');
    });

    it('handles multiple plain domains', () => {
      const { plainDomains } = parseDomainList(['github.com', 'npm.pkg.github.com']);
      expect(plainDomains).toHaveLength(2);
    });
  });

  describe('wildcard patterns', () => {
    it('categorizes *.github.com as a pattern, not a plain domain', () => {
      const { plainDomains, patterns } = parseDomainList(['*.github.com']);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].original).toBe('*.github.com');
      expect(plainDomains).toHaveLength(0);
    });

    it('records protocol restriction on wildcard patterns', () => {
      const { patterns } = parseDomainList(['https://*.github.com']);
      expect(patterns[0].protocol).toBe('https');
    });
  });

  describe('empty and mixed input', () => {
    it('returns empty arrays for empty input', () => {
      const { plainDomains, patterns } = parseDomainList([]);
      expect(plainDomains).toHaveLength(0);
      expect(patterns).toHaveLength(0);
    });

    it('handles a mix of plain and wildcard domains', () => {
      const { plainDomains, patterns } = parseDomainList(['github.com', '*.npm.github.com']);
      expect(plainDomains).toHaveLength(1);
      expect(patterns).toHaveLength(1);
    });
  });

  describe('validation errors', () => {
    it('throws for an invalid domain in the list', () => {
      expect(() => parseDomainList(['github.com', 'bad domain'])).toThrow();
    });

    it('throws for a domain with injection characters', () => {
      expect(() => parseDomainList(['github.com#evil'])).toThrow(/invalid character/i);
    });

    it('throws for over-broad wildcard', () => {
      expect(() => parseDomainList(['*'])).toThrow(/matches all domains/i);
    });
  });
});

// ─── isDomainMatchedByPattern ─────────────────────────────────────────────────

describe('isDomainMatchedByPattern', () => {
  const makePattern = (original: string, protocol: 'http' | 'https' | 'both' = 'both') => {
    // Build a DomainPattern-compatible object inline
    const { patterns } = parseDomainList([original]);
    if (patterns.length === 0) throw new Error('Not a wildcard pattern: ' + original);
    // Override protocol for test purposes
    return [{ ...patterns[0], protocol }];
  };

  it('returns false when domain is too long (>512 chars)', () => {
    const longDomain = 'a'.repeat(513) + '.com';
    const patterns = makePattern('*.com');
    const result = isDomainMatchedByPattern({ domain: longDomain, protocol: 'both' }, patterns);
    expect(result).toBe(false);
  });

  it('returns true when domain matches pattern with protocol=both', () => {
    const patterns = makePattern('*.github.com', 'both');
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'https' }, patterns)).toBe(true);
  });

  it('returns false when domain does not match pattern', () => {
    const patterns = makePattern('*.github.com', 'both');
    expect(isDomainMatchedByPattern({ domain: 'evil.example.com', protocol: 'https' }, patterns)).toBe(false);
  });

  it('returns true when protocol matches exactly (http pattern, http domain)', () => {
    const patterns = makePattern('*.github.com', 'http');
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'http' }, patterns)).toBe(true);
  });

  it('returns false when protocol does not match (https pattern, http domain)', () => {
    const patterns = makePattern('*.github.com', 'https');
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'http' }, patterns)).toBe(false);
  });

  it('returns false when domain needs both protocols but pattern only covers http', () => {
    const patterns = makePattern('*.github.com', 'http');
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, patterns)).toBe(false);
  });

  it('returns false for an empty pattern list', () => {
    expect(isDomainMatchedByPattern({ domain: 'github.com', protocol: 'both' }, [])).toBe(false);
  });

  it('is case-insensitive (uppercase domain matches lowercase pattern)', () => {
    const patterns = makePattern('*.github.com', 'both');
    expect(isDomainMatchedByPattern({ domain: 'API.GITHUB.COM', protocol: 'both' }, patterns)).toBe(true);
  });
});

// ─── parseUrlPatterns ─────────────────────────────────────────────────────────

describe('parseUrlPatterns', () => {
  it('returns an empty array for empty input', () => {
    expect(parseUrlPatterns([])).toEqual([]);
  });

  it('anchors an exact domain with ^ and $', () => {
    const [result] = parseUrlPatterns(['https://github.com']);
    expect(result).toMatch(/^\^/);
    expect(result).toMatch(/\$$/);
    expect(result).toContain('github\\.com');
  });

  it('strips trailing slash', () => {
    const [result] = parseUrlPatterns(['https://github.com/']);
    expect(result).not.toContain('/$');
  });

  it('converts * in path to URL_CHAR_PATTERN and does not add end anchor', () => {
    const [result] = parseUrlPatterns(['https://github.com/myorg/*']);
    expect(result).toMatch(/^\^/);
    // Wildcard at end: no $ anchor
    expect(result).not.toMatch(/\$$/);
  });

  it('converts * in hostname to HOST_CHAR_PATTERN (does not match /)', () => {
    const [result] = parseUrlPatterns(['https://api-*.github.com']);
    // HOST_CHAR_PATTERN is [^\s/]* — verify the hostname part is not URL_CHAR_PATTERN
    expect(result).toContain('[^\\s/]*');
  });

  it('escapes regex special characters in the URL', () => {
    const [result] = parseUrlPatterns(['https://api.github.com/v1/items']);
    expect(result).toContain('api\\.github\\.com');
  });

  it('preserves existing .* patterns (via placeholder)', () => {
    const [result] = parseUrlPatterns(['https://github.com/path/.*']);
    // .* should become the URL_CHAR_PATTERN, not be double-escaped
    expect(result).not.toContain('\\.\\*');
  });

  it('handles a URL without a path section', () => {
    const [result] = parseUrlPatterns(['https://api.example.com']);
    expect(result).toMatch(/^\^https:\/\/api\\.example\\.com\$/);
  });
});
