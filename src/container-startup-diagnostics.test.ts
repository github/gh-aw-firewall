import { reportBlockedDomains } from './container-startup-diagnostics';

describe('container-startup-diagnostics', () => {
  it('classifies missing domains, non-standard ports, and protocol mismatches independently', () => {
    const messages: string[] = [];

    const result = reportBlockedDomains(
      [
        { target: 'api.github.com:8443', domain: 'api.github.com', port: '8443' },
        { target: 'missing.com:443', domain: 'missing.com', port: '443' },
        { target: 'secure.example.com:443', domain: 'secure.example.com', port: '443' },
      ],
      ['*.github.com', 'http://secure.example.com'],
      message => messages.push(message)
    );

    expect(result).toEqual({
      missingDomains: ['missing.com'],
      portIssues: [{ target: 'api.github.com:8443', domain: 'api.github.com', port: '8443' }],
      protocolIssues: [{ target: 'secure.example.com:443', domain: 'secure.example.com', port: '443' }],
    });
    expect(messages).toContain('  - Blocked: api.github.com:8443 (port 8443 not allowed, only 80 and 443 are permitted)');
    expect(messages).toContain('  - Blocked: missing.com:443 (domain not in allowlist)');
    expect(messages).toContain('  - Blocked: secure.example.com:443 (protocol not allowed by allowlist entry)');
    expect(messages).toContain('To fix domain issues: --allow-domains "*.github.com,http://secure.example.com,missing.com"');
    expect(messages).toContain('To fix port issues: Use standard ports 80 (HTTP) or 443 (HTTPS)');
    expect(messages).toContain('To fix protocol issues: add an allowlist entry for the correct protocol (http://domain or https://domain), or allow both by using the bare domain');
  });
});
