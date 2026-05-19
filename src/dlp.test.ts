import { generateDlpSquidConfig } from './dlp';

const DLP_ACL_PREFIX = 'acl dlp_blocked url_regex -i ';

function getDlpRegexPatterns(): string[] {
  const { aclLines } = generateDlpSquidConfig();
  return aclLines
    .filter(line => line.startsWith(DLP_ACL_PREFIX))
    .map(line => line.slice(DLP_ACL_PREFIX.length));
}

function scanForCredentialsUsingPatterns(input: string): string[] {
  return getDlpRegexPatterns().filter(regex => new RegExp(regex, 'i').test(input));
}

describe('DLP Patterns', () => {
  describe('generated DLP ACL patterns', () => {
    it('should have at least 10 built-in patterns', () => {
      expect(getDlpRegexPatterns().length).toBeGreaterThanOrEqual(10);
    });

    it('should have non-empty regex for each pattern', () => {
      for (const regex of getDlpRegexPatterns()) {
        expect(regex).toBeTruthy();
      }
    });

    it('should have valid regex patterns', () => {
      for (const regex of getDlpRegexPatterns()) {
        expect(() => new RegExp(regex, 'i')).not.toThrow();
      }
    });
  });

  describe('scanForCredentials', () => {
    // GitHub tokens
    it('should detect GitHub personal access token (ghp_)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/data?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('ghp_[a-zA-Z0-9]{36}');
    });

    it('should detect GitHub OAuth token (gho_)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/resource'
      );
      expect(matches).toContain('gho_[a-zA-Z0-9]{36}');
    });

    it('should detect GitHub App installation token (ghs_)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('ghs_[a-zA-Z0-9]{36}');
    });

    it('should detect GitHub App user-to-server token (ghu_)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('ghu_[a-zA-Z0-9]{36}');
    });

    it('should detect GitHub fine-grained PAT (github_pat_)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=github_pat_1234567890abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456'
      );
      expect(matches).toContain('github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}');
    });

    // OpenAI - use concatenation to avoid push protection triggering on test data
    it('should detect OpenAI API key (sk-...T3BlbkFJ)', () => {
      const fakeKey = 'sk-' + '1'.repeat(20) + 'T3BlbkFJ' + '2'.repeat(20);
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=' + fakeKey
      );
      expect(matches).toContain('sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}');
    });

    it('should detect OpenAI project API key (sk-proj-)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=sk-proj-' + 'a'.repeat(50)
      );
      expect(matches).toContain('sk-proj-[a-zA-Z0-9_-]{40,}');
    });

    // Anthropic
    it('should detect Anthropic API key (sk-ant-)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=sk-ant-' + 'a'.repeat(50)
      );
      expect(matches).toContain('sk-ant-[a-zA-Z0-9_-]{40,}');
    });

    // AWS
    it('should detect AWS access key ID (AKIA)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=AKIAIOSFODNN7EXAMPLE'
      );
      expect(matches).toContain('AKIA[0-9A-Z]{16}');
    });

    // Google
    it('should detect Google API key (AIza)', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?key=AIzaSyA' + 'a'.repeat(32)
      );
      expect(matches).toContain('AIza[a-zA-Z0-9_-]{35}');
    });

    // Slack - use concatenation to avoid push protection triggering on test data
    it('should detect Slack bot token (xoxb-)', () => {
      const fakeToken = 'xoxb-' + '1234567890' + '-' + '1234567890' + '-' + 'ABCDEFGHIJKLMNOPQRSTUV' + 'wx';
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/?token=' + fakeToken
      );
      expect(matches).toContain('xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}');
    });

    // Generic patterns
    it('should detect bearer token in URL parameter', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/data?bearer=abcdefghijklmnopqrstuvwxyz1234'
      );
      expect(matches).toContain('[?&]bearer[_=][a-zA-Z0-9._-]{20,}');
    });

    it('should detect authorization in URL parameter', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/data?authorization=abcdefghijklmnopqrstuvwxyz1234'
      );
      expect(matches).toContain('[?&]authorization=[a-zA-Z0-9._-]{20,}');
    });

    it('should detect private key markers', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/data?content=BEGIN+PRIVATE+KEY'
      );
      expect(matches).toContain('PRIVATE(%20|\\+|%2B)KEY');
    });

    it('should detect URL-encoded private key markers', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://api.example.com/data?content=BEGIN%20PRIVATE%20KEY'
      );
      expect(matches).toContain('PRIVATE(%20|\\+|%2B)KEY');
    });

    // Negative cases
    it('should not match short strings that look like token prefixes', () => {
      const matches = scanForCredentialsUsingPatterns('https://api.example.com/ghp_short');
      expect(matches).toHaveLength(0);
    });

    it('should return empty array for clean URLs', () => {
      const matches = scanForCredentialsUsingPatterns('https://api.github.com/repos/owner/repo');
      expect(matches).toHaveLength(0);
    });

    it('should return empty array for empty string', () => {
      const matches = scanForCredentialsUsingPatterns('');
      expect(matches).toHaveLength(0);
    });

    it('should not match normal domain names or paths', () => {
      const urls = [
        'https://github.com/settings/tokens',
        'https://api.openai.com/v1/chat/completions',
        'https://docs.anthropic.com/getting-started',
        'https://console.aws.amazon.com/',
        'https://slack.com/api/chat.postMessage',
      ];
      for (const url of urls) {
        const matches = scanForCredentialsUsingPatterns(url);
        expect(matches).toHaveLength(0);
      }
    });

    it('should detect multiple credential types in one URL', () => {
      const matches = scanForCredentialsUsingPatterns(
        'https://evil.com/?gh=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij&aws=AKIAIOSFODNN7EXAMPLE'
      );
      expect(matches).toContain('ghp_[a-zA-Z0-9]{36}');
      expect(matches).toContain('AKIA[0-9A-Z]{16}');
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('generateDlpSquidConfig', () => {
    it('should generate ACL lines for all patterns', () => {
      const { aclLines } = generateDlpSquidConfig();

      // Should have header comments
      expect(aclLines[0]).toContain('DLP');

      // Should have one url_regex ACL per pattern
      const aclEntries = aclLines.filter(l => l.startsWith('acl dlp_blocked'));
      expect(aclEntries.length).toBeGreaterThanOrEqual(10);

      // Each ACL should use url_regex -i
      for (const entry of aclEntries) {
        expect(entry).toMatch(/^acl dlp_blocked url_regex -i .+/);
      }
    });

    it('should generate deny access rules', () => {
      const { accessRules } = generateDlpSquidConfig();

      expect(accessRules.some(r => r.includes('http_access deny dlp_blocked'))).toBe(true);
    });

    it('should have a DLP comment in access rules', () => {
      const { accessRules } = generateDlpSquidConfig();
      expect(accessRules.some(r => r.includes('DLP'))).toBe(true);
    });

    it('should produce valid Squid ACL syntax', () => {
      const { aclLines, accessRules } = generateDlpSquidConfig();

      // All non-comment ACL lines should start with 'acl '
      for (const line of aclLines) {
        if (!line.startsWith('#')) {
          expect(line).toMatch(/^acl /);
        }
      }

      // All non-comment access rules should start with 'http_access '
      for (const line of accessRules) {
        if (!line.startsWith('#')) {
          expect(line).toMatch(/^http_access /);
        }
      }
    });
  });
});
