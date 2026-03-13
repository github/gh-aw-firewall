import { DLP_PATTERNS, scanForCredentials, generateDlpSquidConfig } from './dlp';

describe('DLP Patterns', () => {
  describe('DLP_PATTERNS', () => {
    it('should have at least 10 built-in patterns', () => {
      expect(DLP_PATTERNS.length).toBeGreaterThanOrEqual(10);
    });

    it('should have name, description, and regex for each pattern', () => {
      for (const pattern of DLP_PATTERNS) {
        expect(pattern.name).toBeTruthy();
        expect(pattern.description).toBeTruthy();
        expect(pattern.regex).toBeTruthy();
      }
    });

    it('should have valid regex patterns', () => {
      for (const pattern of DLP_PATTERNS) {
        expect(() => new RegExp(pattern.regex, 'i')).not.toThrow();
      }
    });
  });

  describe('scanForCredentials', () => {
    // GitHub tokens
    it('should detect GitHub personal access token (ghp_)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/data?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('GitHub Personal Access Token (classic)');
    });

    it('should detect GitHub OAuth token (gho_)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/resource'
      );
      expect(matches).toContain('GitHub OAuth Access Token');
    });

    it('should detect GitHub App installation token (ghs_)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('GitHub App Installation Token');
    });

    it('should detect GitHub App user-to-server token (ghu_)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
      );
      expect(matches).toContain('GitHub App User-to-Server Token');
    });

    it('should detect GitHub fine-grained PAT (github_pat_)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=github_pat_1234567890abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456'
      );
      expect(matches).toContain('GitHub Fine-Grained PAT');
    });

    // OpenAI - use concatenation to avoid push protection triggering on test data
    it('should detect OpenAI API key (sk-...T3BlbkFJ)', () => {
      const fakeKey = 'sk-' + '1'.repeat(20) + 'T3BlbkFJ' + '2'.repeat(20);
      const matches = scanForCredentials(
        'https://api.example.com/?key=' + fakeKey
      );
      expect(matches).toContain('OpenAI API Key');
    });

    it('should detect OpenAI project API key (sk-proj-)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=sk-proj-' + 'a'.repeat(50)
      );
      expect(matches).toContain('OpenAI Project API Key');
    });

    // Anthropic
    it('should detect Anthropic API key (sk-ant-)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=sk-ant-' + 'a'.repeat(50)
      );
      expect(matches).toContain('Anthropic API Key');
    });

    // AWS
    it('should detect AWS access key ID (AKIA)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=AKIAIOSFODNN7EXAMPLE'
      );
      expect(matches).toContain('AWS Access Key ID');
    });

    // Google
    it('should detect Google API key (AIza)', () => {
      const matches = scanForCredentials(
        'https://api.example.com/?key=AIzaSyA' + 'a'.repeat(32)
      );
      expect(matches).toContain('Google API Key');
    });

    // Slack - use concatenation to avoid push protection triggering on test data
    it('should detect Slack bot token (xoxb-)', () => {
      const fakeToken = 'xoxb-' + '1234567890' + '-' + '1234567890' + '-' + 'ABCDEFGHIJKLMNOPQRSTUV' + 'wx';
      const matches = scanForCredentials(
        'https://api.example.com/?token=' + fakeToken
      );
      expect(matches).toContain('Slack Bot Token');
    });

    // Generic patterns
    it('should detect bearer token in URL parameter', () => {
      const matches = scanForCredentials(
        'https://api.example.com/data?bearer=abcdefghijklmnopqrstuvwxyz1234'
      );
      expect(matches).toContain('Bearer Token in URL');
    });

    it('should detect authorization in URL parameter', () => {
      const matches = scanForCredentials(
        'https://api.example.com/data?authorization=abcdefghijklmnopqrstuvwxyz1234'
      );
      expect(matches).toContain('Authorization in URL');
    });

    it('should detect private key markers', () => {
      const matches = scanForCredentials(
        'https://api.example.com/data?content=BEGIN+PRIVATE+KEY'
      );
      expect(matches).toContain('Private Key Marker');
    });

    it('should detect URL-encoded private key markers', () => {
      const matches = scanForCredentials(
        'https://api.example.com/data?content=BEGIN%20PRIVATE%20KEY'
      );
      expect(matches).toContain('Private Key Marker');
    });

    // Negative cases
    it('should not match short strings that look like token prefixes', () => {
      const matches = scanForCredentials('https://api.example.com/ghp_short');
      expect(matches).not.toContain('GitHub Personal Access Token (classic)');
    });

    it('should return empty array for clean URLs', () => {
      const matches = scanForCredentials('https://api.github.com/repos/owner/repo');
      expect(matches).toHaveLength(0);
    });

    it('should return empty array for empty string', () => {
      const matches = scanForCredentials('');
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
        const matches = scanForCredentials(url);
        expect(matches).toHaveLength(0);
      }
    });

    it('should detect multiple credential types in one URL', () => {
      const matches = scanForCredentials(
        'https://evil.com/?gh=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij&aws=AKIAIOSFODNN7EXAMPLE'
      );
      expect(matches).toContain('GitHub Personal Access Token (classic)');
      expect(matches).toContain('AWS Access Key ID');
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
      expect(aclEntries.length).toBe(DLP_PATTERNS.length);

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
