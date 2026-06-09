import { reportBlockedDomains } from './container-startup-diagnostics';

describe('container-startup-diagnostics', () => {
  it('classifies missing domains and non-standard ports independently', () => {
    const messages: string[] = [];

    const result = reportBlockedDomains(
      [
        { target: 'api.github.com:8443', domain: 'api.github.com', port: '8443' },
        { target: 'missing.com:443', domain: 'missing.com', port: '443' },
      ],
      ['*.github.com'],
      message => messages.push(message)
    );

    expect(result).toEqual({
      missingDomains: ['missing.com'],
      portIssues: [{ target: 'api.github.com:8443', domain: 'api.github.com', port: '8443' }],
    });
    expect(messages).toContain('  - Blocked: api.github.com:8443 (port 8443 not allowed, only 80 and 443 are permitted)');
    expect(messages).toContain('  - Blocked: missing.com:443 (domain not in allowlist)');
    expect(messages).toContain('To fix domain issues: --allow-domains "*.github.com,missing.com"');
    expect(messages).toContain('To fix port issues: Use standard ports 80 (HTTP) or 443 (HTTPS)');
  });
});
