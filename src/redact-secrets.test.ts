import { deriveSensitiveEndpointForms, redactSensitiveValues } from './redact-secrets';

describe('deriveSensitiveEndpointForms', () => {
  it('returns an empty list when there are no sensitive domains', () => {
    expect(deriveSensitiveEndpointForms()).toEqual([]);
    expect(deriveSensitiveEndpointForms([])).toEqual([]);
    expect(deriveSensitiveEndpointForms(['  '])).toEqual([]);
  });

  it('derives url, host and host:port forms for https entries', () => {
    const forms = deriveSensitiveEndpointForms(['https://lb.internal.example.com']);
    expect(forms).toEqual(expect.arrayContaining([
      'https://lb.internal.example.com',
      'lb.internal.example.com',
      'lb.internal.example.com:443',
    ]));
  });

  it('uses port 80 for http entries', () => {
    expect(deriveSensitiveEndpointForms(['http://lb.internal'])).toEqual(
      expect.arrayContaining(['http://lb.internal', 'lb.internal', 'lb.internal:80'])
    );
  });

  it('orders longest forms first so the most specific match is redacted', () => {
    const forms = deriveSensitiveEndpointForms(['https://lb.internal']);
    const lengths = forms.map((form) => form.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe('redactSensitiveValues', () => {
  it('replaces every occurrence of each sensitive value', () => {
    const forms = deriveSensitiveEndpointForms(['https://lb.internal.example.com']);
    const text = [
      'acl allowed_domains dstdomain .lb.internal.example.com',
      'OPENAI_API_TARGET=lb.internal.example.com',
      'CONNECT lb.internal.example.com:443',
    ].join('\n');

    const redacted = redactSensitiveValues(text, forms);

    expect(redacted).not.toContain('lb.internal.example.com');
    expect(redacted).toContain('[REDACTED]');
  });

  it('returns the input unchanged when no values are supplied', () => {
    expect(redactSensitiveValues('nothing to redact', [])).toBe('nothing to redact');
  });

  it('redacts endpoint forms irrespective of URL or hostname casing', () => {
    const forms = deriveSensitiveEndpointForms(['https://lb.secret.example.com']);
    expect(redactSensitiveValues(
      'OPENAI_ENDPOINT_OVERRIDE=https://LB.Secret.Example.Com/v1',
      forms
    )).not.toContain('LB.Secret.Example.Com');
  });
});
