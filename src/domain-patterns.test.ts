import {
  isWildcardPattern,
  wildcardToRegex,
  parseDomainWithProtocol,
} from './domain-patterns';
import { validateDomainOrPattern, SQUID_DANGEROUS_CHARS } from './domain-validation';
import {
  parseDomainList,
  isDomainMatchedByPattern,
  parseUrlPatterns,
} from './domain-matchers';

const WILDCARD_DOMAIN_CHARS = '[a-zA-Z0-9.-]*';

describe('parseDomainWithProtocol', () => {
  it('should parse domain without protocol as "both"', () => {
    expect(parseDomainWithProtocol('github.com')).toEqual({
      domain: 'github.com',
      protocol: 'both',
    });
  });

  it('should parse http:// prefix as "http"', () => {
    expect(parseDomainWithProtocol('http://github.com')).toEqual({
      domain: 'github.com',
      protocol: 'http',
    });
  });

  it('should parse https:// prefix as "https"', () => {
    expect(parseDomainWithProtocol('https://github.com')).toEqual({
      domain: 'github.com',
      protocol: 'https',
    });
  });

  it('should strip trailing slash', () => {
    expect(parseDomainWithProtocol('github.com/')).toEqual({
      domain: 'github.com',
      protocol: 'both',
    });
    expect(parseDomainWithProtocol('http://github.com/')).toEqual({
      domain: 'github.com',
      protocol: 'http',
    });
    expect(parseDomainWithProtocol('https://github.com/')).toEqual({
      domain: 'github.com',
      protocol: 'https',
    });
  });

  it('should trim whitespace', () => {
    expect(parseDomainWithProtocol('  github.com  ')).toEqual({
      domain: 'github.com',
      protocol: 'both',
    });
    expect(parseDomainWithProtocol('  http://github.com  ')).toEqual({
      domain: 'github.com',
      protocol: 'http',
    });
  });

  it('should handle wildcard patterns with protocol', () => {
    expect(parseDomainWithProtocol('http://*.example.com')).toEqual({
      domain: '*.example.com',
      protocol: 'http',
    });
    expect(parseDomainWithProtocol('https://*.secure.com')).toEqual({
      domain: '*.secure.com',
      protocol: 'https',
    });
  });

  it('should handle subdomains with protocol', () => {
    expect(parseDomainWithProtocol('http://api.github.com')).toEqual({
      domain: 'api.github.com',
      protocol: 'http',
    });
    expect(parseDomainWithProtocol('https://secure.api.github.com')).toEqual({
      domain: 'secure.api.github.com',
      protocol: 'https',
    });
  });
});

describe('isWildcardPattern', () => {
  it('should detect asterisk wildcard', () => {
    expect(isWildcardPattern('*.github.com')).toBe(true);
    expect(isWildcardPattern('api-*.example.com')).toBe(true);
    expect(isWildcardPattern('*-cdn.example.com')).toBe(true);
    expect(isWildcardPattern('api.*.com')).toBe(true);
  });

  it('should return false for plain domains', () => {
    expect(isWildcardPattern('github.com')).toBe(false);
    expect(isWildcardPattern('api.github.com')).toBe(false);
    expect(isWildcardPattern('.github.com')).toBe(false);
    expect(isWildcardPattern('sub.domain.example.com')).toBe(false);
  });
});

describe('wildcardToRegex', () => {
  describe('basic conversions', () => {
    it('should convert leading wildcard pattern', () => {
      expect(wildcardToRegex('*.github.com')).toBe(`^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`);
    });

    it('should convert middle wildcard pattern', () => {
      expect(wildcardToRegex('api-*.example.com')).toBe(`^api-${WILDCARD_DOMAIN_CHARS}\\.example\\.com$`);
    });

    it('should convert trailing wildcard pattern', () => {
      expect(wildcardToRegex('api.*')).toBe(`^api\\.${WILDCARD_DOMAIN_CHARS}$`);
    });

    it('should handle multiple wildcards', () => {
      expect(wildcardToRegex('*-api-*.example.com')).toBe(`^${WILDCARD_DOMAIN_CHARS}-api-${WILDCARD_DOMAIN_CHARS}\\.example\\.com$`);
    });
  });

  describe('escaping', () => {
    it('should escape dots in domain', () => {
      expect(wildcardToRegex('*.co.uk')).toBe(`^${WILDCARD_DOMAIN_CHARS}\\.co\\.uk$`);
    });

    it('should escape regex metacharacters', () => {
      // These are unlikely in domains but should be handled safely
      expect(wildcardToRegex('api+*.example.com')).toBe(`^api\\+${WILDCARD_DOMAIN_CHARS}\\.example\\.com$`);
      expect(wildcardToRegex('api[1].example.com')).toBe('^api\\[1\\]\\.example\\.com$');
    });
  });

  describe('anchoring', () => {
    it('should anchor regex with ^ and $', () => {
      const regex = wildcardToRegex('*.github.com');
      expect(regex.startsWith('^')).toBe(true);
      expect(regex.endsWith('$')).toBe(true);
    });
  });

  describe('regex validity', () => {
    it('should produce valid regex patterns', () => {
      const patterns = [
        '*.github.com',
        'api-*.example.com',
        '*-cdn.example.com',
        'api.*.example.com',
      ];

      for (const pattern of patterns) {
        const regex = wildcardToRegex(pattern);
        expect(() => new RegExp(regex)).not.toThrow();
      }
    });

    it('should correctly match intended domains', () => {
      const regex = new RegExp(wildcardToRegex('*.github.com'), 'i');
      expect(regex.test('api.github.com')).toBe(true);
      expect(regex.test('raw.github.com')).toBe(true);
      expect(regex.test('sub.api.github.com')).toBe(true);
      expect(regex.test('github.com')).toBe(false); // * requires at least one char before .
      expect(regex.test('notgithub.com')).toBe(false);
      expect(regex.test('github.com.evil.com')).toBe(false);
    });

    it('should handle middle wildcards correctly', () => {
      const regex = new RegExp(wildcardToRegex('api-*.example.com'), 'i');
      expect(regex.test('api-v1.example.com')).toBe(true);
      expect(regex.test('api-test.example.com')).toBe(true);
      expect(regex.test('api-.example.com')).toBe(true); // empty wildcard match
      expect(regex.test('api.example.com')).toBe(false); // missing dash
      expect(regex.test('other.example.com')).toBe(false);
    });
  });
});

describe('validateDomainOrPattern', () => {
  describe('valid inputs', () => {
    it('should accept valid plain domains', () => {
      expect(() => validateDomainOrPattern('github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('api.github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('sub.api.github.com')).not.toThrow();
    });

    it('should accept valid wildcard patterns', () => {
      expect(() => validateDomainOrPattern('*.github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('api-*.example.com')).not.toThrow();
      expect(() => validateDomainOrPattern('*-cdn.example.com')).not.toThrow();
    });

    it('should accept domains with hyphens and numbers', () => {
      expect(() => validateDomainOrPattern('api-v2.github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('123.example.com')).not.toThrow();
    });
  });

  describe('empty/invalid inputs', () => {
    it('should reject empty input', () => {
      expect(() => validateDomainOrPattern('')).toThrow('cannot be empty');
      expect(() => validateDomainOrPattern('   ')).toThrow('cannot be empty');
    });

    it('should reject double dots', () => {
      expect(() => validateDomainOrPattern('github..com')).toThrow('double dots');
      expect(() => validateDomainOrPattern('*.github..com')).toThrow('double dots');
    });

    it('should reject just a dot', () => {
      expect(() => validateDomainOrPattern('.')).toThrow();
    });

    it('should reject incomplete patterns', () => {
      // These are caught by the "too broad" check since they match ^[\*\.]+$
      expect(() => validateDomainOrPattern('*.')).toThrow('too broad');
      expect(() => validateDomainOrPattern('.*')).toThrow('too broad');
    });
  });

  describe('overly broad patterns', () => {
    it('should reject single asterisk', () => {
      expect(() => validateDomainOrPattern('*')).toThrow("matches all domains");
    });

    it('should reject *.*', () => {
      expect(() => validateDomainOrPattern('*.*')).toThrow("too broad");
    });

    it('should reject patterns with only wildcards and dots', () => {
      expect(() => validateDomainOrPattern('*.*.*')).toThrow("too broad");
    });

    it('should reject patterns with too many wildcard segments', () => {
      expect(() => validateDomainOrPattern('*.*.com')).toThrow("too many wildcard segments");
    });
  });

  describe('rejects injection characters', () => {
    it('should reject LF in domain', () => {
      expect(() => validateDomainOrPattern('evil.com\nhttp_access allow all')).toThrow('contains invalid character');
    });

    it('should reject CR in domain', () => {
      expect(() => validateDomainOrPattern('evil.com\rhttp_access allow all')).toThrow('contains invalid character');
    });

    it('should reject CRLF in domain', () => {
      expect(() => validateDomainOrPattern('evil.com\r\nhttp_access allow all')).toThrow('contains invalid character');
    });

    it('should reject null bytes', () => {
      expect(() => validateDomainOrPattern('evil.com\0')).toThrow('contains invalid character');
    });

    it('should reject tabs', () => {
      expect(() => validateDomainOrPattern('evil.com\tallowed')).toThrow('contains invalid character');
    });

    it('should reject interior spaces', () => {
      expect(() => validateDomainOrPattern('evil.com allowed')).toThrow('contains invalid character');
    });

    it('should reject space-separated domains (ACL token injection)', () => {
      expect(() => validateDomainOrPattern('.evil.com .attacker.com')).toThrow('contains invalid character');
    });

    it('should reject semicolons', () => {
      expect(() => validateDomainOrPattern('evil.com;rm -rf')).toThrow('contains invalid character');
    });

    it('should reject hash characters', () => {
      expect(() => validateDomainOrPattern('evil.com#comment')).toThrow('contains invalid character');
    });

    it('should reject backslashes', () => {
      expect(() => validateDomainOrPattern('evil.com\\n')).toThrow('contains invalid character');
    });

    it('should reject single quotes', () => {
      expect(() => validateDomainOrPattern("evil.com'")).toThrow('contains invalid character');
    });

    it('should reject double quotes', () => {
      expect(() => validateDomainOrPattern('evil.com"')).toThrow('contains invalid character');
    });

    it('should include U+ codepoint in control-character error messages', () => {
      expect(() => validateDomainOrPattern('evil.com\0')).toThrow(/U\+/);
    });
  });

  describe('accepts valid DNS names with underscores', () => {
    it('should accept _dmarc.example.com', () => {
      expect(() => validateDomainOrPattern('_dmarc.example.com')).not.toThrow();
    });

    it('should accept _acme-challenge.example.com', () => {
      expect(() => validateDomainOrPattern('_acme-challenge.example.com')).not.toThrow();
    });

    it('should accept _srv._tcp.example.com', () => {
      expect(() => validateDomainOrPattern('_srv._tcp.example.com')).not.toThrow();
    });
  });

  describe('SQUID_DANGEROUS_CHARS', () => {
    it('should match dangerous injection characters', () => {
      expect(SQUID_DANGEROUS_CHARS.test('"')).toBe(true);
      expect(SQUID_DANGEROUS_CHARS.test("'")).toBe(true);
      expect(SQUID_DANGEROUS_CHARS.test(';')).toBe(true);
      expect(SQUID_DANGEROUS_CHARS.test('#')).toBe(true);
    });
  });

  describe('protocol-prefixed domains', () => {
    it('should accept valid http:// prefixed domains', () => {
      expect(() => validateDomainOrPattern('http://github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('http://api.github.com')).not.toThrow();
    });

    it('should accept valid https:// prefixed domains', () => {
      expect(() => validateDomainOrPattern('https://github.com')).not.toThrow();
      expect(() => validateDomainOrPattern('https://secure.example.com')).not.toThrow();
    });

    it('should accept protocol-prefixed wildcard patterns', () => {
      expect(() => validateDomainOrPattern('http://*.example.com')).not.toThrow();
      expect(() => validateDomainOrPattern('https://*.secure.com')).not.toThrow();
    });

    it('should reject protocol prefix with empty domain', () => {
      expect(() => validateDomainOrPattern('http://')).toThrow('cannot be empty');
      expect(() => validateDomainOrPattern('https://')).toThrow('cannot be empty');
    });

    it('should reject overly broad patterns even with protocol prefix', () => {
      expect(() => validateDomainOrPattern('http://*')).toThrow("matches all domains");
      expect(() => validateDomainOrPattern('https://*.*')).toThrow("too broad");
    });
  });
});

describe('parseDomainList', () => {
  it('should separate plain domains from patterns', () => {
    const result = parseDomainList(['github.com', '*.gitlab.com', 'example.com']);
    expect(result.plainDomains).toEqual([
      { domain: 'github.com', protocol: 'both' },
      { domain: 'example.com', protocol: 'both' },
    ]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].original).toBe('*.gitlab.com');
    expect(result.patterns[0].protocol).toBe('both');
  });

  it('should convert patterns to regex', () => {
    const result = parseDomainList(['*.github.com']);
    expect(result.patterns[0].regex).toBe(`^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`);
  });

  it('should handle all plain domains', () => {
    const result = parseDomainList(['github.com', 'gitlab.com', 'example.com']);
    expect(result.plainDomains).toEqual([
      { domain: 'github.com', protocol: 'both' },
      { domain: 'gitlab.com', protocol: 'both' },
      { domain: 'example.com', protocol: 'both' },
    ]);
    expect(result.patterns).toHaveLength(0);
  });

  it('should handle all patterns', () => {
    const result = parseDomainList(['*.github.com', '*.gitlab.com']);
    expect(result.plainDomains).toHaveLength(0);
    expect(result.patterns).toHaveLength(2);
  });

  it('should throw on invalid pattern', () => {
    expect(() => parseDomainList(['github.com', '*'])).toThrow();
    expect(() => parseDomainList(['github..com'])).toThrow();
  });

  it('should handle empty list', () => {
    const result = parseDomainList([]);
    expect(result.plainDomains).toHaveLength(0);
    expect(result.patterns).toHaveLength(0);
  });

  describe('protocol parsing', () => {
    it('should parse http:// prefix as http protocol', () => {
      const result = parseDomainList(['http://github.com']);
      expect(result.plainDomains).toEqual([
        { domain: 'github.com', protocol: 'http' },
      ]);
    });

    it('should parse https:// prefix as https protocol', () => {
      const result = parseDomainList(['https://github.com']);
      expect(result.plainDomains).toEqual([
        { domain: 'github.com', protocol: 'https' },
      ]);
    });

    it('should handle mixed protocols', () => {
      const result = parseDomainList(['http://api.example.com', 'https://secure.example.com', 'example.com']);
      expect(result.plainDomains).toEqual([
        { domain: 'api.example.com', protocol: 'http' },
        { domain: 'secure.example.com', protocol: 'https' },
        { domain: 'example.com', protocol: 'both' },
      ]);
    });

    it('should handle protocol-prefixed wildcard patterns', () => {
      const result = parseDomainList(['http://*.example.com', 'https://*.secure.com']);
      expect(result.patterns).toEqual([
        { original: '*.example.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.example\\.com$`, protocol: 'http' },
        { original: '*.secure.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.secure\\.com$`, protocol: 'https' },
      ]);
    });

    it('should strip trailing slash after protocol', () => {
      const result = parseDomainList(['http://github.com/', 'https://example.com/']);
      expect(result.plainDomains).toEqual([
        { domain: 'github.com', protocol: 'http' },
        { domain: 'example.com', protocol: 'https' },
      ]);
    });
  });
});

describe('isDomainMatchedByPattern', () => {
  it('should match domain against leading wildcard', () => {
    const patterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'both' as const }];
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'raw.github.com', protocol: 'both' }, patterns)).toBe(true);
  });

  it('should not match domain that does not fit pattern', () => {
    const patterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'both' as const }];
    expect(isDomainMatchedByPattern({ domain: 'github.com', protocol: 'both' }, patterns)).toBe(false);
    expect(isDomainMatchedByPattern({ domain: 'gitlab.com', protocol: 'both' }, patterns)).toBe(false);
    expect(isDomainMatchedByPattern({ domain: 'notgithub.com', protocol: 'both' }, patterns)).toBe(false);
  });

  it('should match against middle wildcard', () => {
    const patterns = [{ original: 'api-*.example.com', regex: `^api-${WILDCARD_DOMAIN_CHARS}\\.example\\.com$`, protocol: 'both' as const }];
    expect(isDomainMatchedByPattern({ domain: 'api-v1.example.com', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'api-test.example.com', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'api.example.com', protocol: 'both' }, patterns)).toBe(false);
  });

  it('should match against any pattern in list', () => {
    const patterns = [
      { original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'both' as const },
      { original: '*.gitlab.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.gitlab\\.com$`, protocol: 'both' as const },
    ];
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'api.gitlab.com', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'api.bitbucket.com', protocol: 'both' }, patterns)).toBe(false);
  });

  it('should be case-insensitive', () => {
    const patterns = [{ original: '*.GitHub.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.GitHub\\.com$`, protocol: 'both' as const }];
    expect(isDomainMatchedByPattern({ domain: 'API.GITHUB.COM', protocol: 'both' }, patterns)).toBe(true);
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, patterns)).toBe(true);
  });

  it('should return false for empty pattern list', () => {
    expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, [])).toBe(false);
  });

  it('should return false for excessively long domains (ReDoS protection)', () => {
    const patterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'both' as const }];
    const longDomain = 'a'.repeat(600) + '.github.com';
    expect(isDomainMatchedByPattern({ domain: longDomain, protocol: 'both' }, patterns)).toBe(false);
  });

  describe('protocol compatibility', () => {
    it('should match when pattern has "both" protocol', () => {
      const patterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'both' as const }];
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'http' }, patterns)).toBe(true);
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'https' }, patterns)).toBe(true);
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, patterns)).toBe(true);
    });

    it('should not fully cover "both" domain with single protocol pattern', () => {
      const httpPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'http' as const }];
      const httpsPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'https' as const }];
      // A domain that needs "both" cannot be fully covered by a single-protocol pattern
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, httpPatterns)).toBe(false);
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'both' }, httpsPatterns)).toBe(false);
    });

    it('should match when protocols match exactly', () => {
      const httpPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'http' as const }];
      const httpsPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'https' as const }];
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'http' }, httpPatterns)).toBe(true);
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'https' }, httpsPatterns)).toBe(true);
    });

    it('should not match when protocols do not match', () => {
      const httpPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'http' as const }];
      const httpsPatterns = [{ original: '*.github.com', regex: `^${WILDCARD_DOMAIN_CHARS}\\.github\\.com$`, protocol: 'https' as const }];
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'https' }, httpPatterns)).toBe(false);
      expect(isDomainMatchedByPattern({ domain: 'api.github.com', protocol: 'http' }, httpsPatterns)).toBe(false);
    });
  });
});

// Pattern constant for the safer URL character class (matches the implementation)
const URL_CHAR_PATTERN = '[^\\s]*';
// Pattern for hostname wildcards (cannot match '/')
const HOST_CHAR_PATTERN = '[^\\s/]*';

describe('parseUrlPatterns', () => {
  it('should escape regex special characters except wildcards', () => {
    const patterns = parseUrlPatterns(['https://github.com/user']);
    expect(patterns).toEqual(['^https://github\\.com/user$']);
  });

  it('should convert * wildcard to safe regex pattern', () => {
    const patterns = parseUrlPatterns(['https://github.com/myorg/*']);
    expect(patterns).toEqual([`^https://github\\.com/myorg/${URL_CHAR_PATTERN}`]);
  });

  it('should handle multiple wildcards', () => {
    const patterns = parseUrlPatterns(['https://api-*.example.com/*']);
    expect(patterns).toEqual([`^https://api-${HOST_CHAR_PATTERN}\\.example\\.com/${URL_CHAR_PATTERN}`]);
  });

  it('should prevent hostname wildcard from matching path separators', () => {
    const patterns = parseUrlPatterns(['https://api-*.example.com/path']);
    const regex = new RegExp(patterns[0]);
    // Should match valid subdomain variations
    expect(regex.test('https://api-v1.example.com/path')).toBe(true);
    expect(regex.test('https://api-staging.example.com/path')).toBe(true);
    // Should NOT match URLs where the wildcard crosses the host/path boundary
    expect(regex.test('https://api-evil.attacker.com/.example.com/path')).toBe(false);
  });

  it('should remove trailing slash for consistency', () => {
    const patterns = parseUrlPatterns(['https://github.com/']);
    expect(patterns).toEqual(['^https://github\\.com$']);
  });

  it('should handle exact match patterns', () => {
    const patterns = parseUrlPatterns(['https://api.example.com/v1/users']);
    expect(patterns).toEqual(['^https://api\\.example\\.com/v1/users$']);
  });

  it('should handle query parameters', () => {
    const patterns = parseUrlPatterns(['https://api.example.com/v1?key=value']);
    expect(patterns).toEqual(['^https://api\\.example\\.com/v1\\?key=value$']);
  });

  it('should escape dots in domain names', () => {
    const patterns = parseUrlPatterns(['https://sub.domain.example.com/path']);
    expect(patterns).toEqual(['^https://sub\\.domain\\.example\\.com/path$']);
  });

  it('should handle multiple patterns', () => {
    const patterns = parseUrlPatterns([
      'https://github.com/myorg/*',
      'https://api.example.com/v1/*',
    ]);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toBe(`^https://github\\.com/myorg/${URL_CHAR_PATTERN}`);
    expect(patterns[1]).toBe(`^https://api\\.example\\.com/v1/${URL_CHAR_PATTERN}`);
  });

  it('should handle empty array', () => {
    const patterns = parseUrlPatterns([]);
    expect(patterns).toEqual([]);
  });

  it('should anchor patterns correctly for exact matches', () => {
    const patterns = parseUrlPatterns(['https://github.com/exact']);
    // Should have both start and end anchors for exact matches
    expect(patterns[0]).toBe('^https://github\\.com/exact$');
  });

  it('should not add end anchor for wildcard patterns', () => {
    const patterns = parseUrlPatterns(['https://github.com/*']);
    // Should only have start anchor for patterns ending with the URL char pattern
    expect(patterns[0]).toBe(`^https://github\\.com/${URL_CHAR_PATTERN}`);
    expect(patterns[0]).not.toContain('$');
  });

  it('should preserve existing .* patterns without escaping them', () => {
    const patterns = parseUrlPatterns(['https://github.com/path/.*']);
    expect(patterns[0]).not.toContain('\\.\\*');
    expect(new RegExp(patterns[0]).test('https://github.com/path/anything')).toBe(true);
  });
});
