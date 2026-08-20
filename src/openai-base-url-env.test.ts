import { resolveOpenAiBaseUrlFromEnv } from './openai-base-url-env';

describe('resolveOpenAiBaseUrlFromEnv', () => {
  const VAR = 'CODEX_LB_BASE_URL';

  it('returns undefined when no env var name is configured', () => {
    expect(resolveOpenAiBaseUrlFromEnv(undefined, {})).toBeUndefined();
  });

  it('derives url, host, host:port and base path from a valid https URL', () => {
    const resolved = resolveOpenAiBaseUrlFromEnv(VAR, {
      [VAR]: 'https://lb.internal.example.com/v1/',
    });
    expect(resolved).toEqual({
      envVarName: VAR,
      url: 'https://lb.internal.example.com/v1',
      scheme: 'https',
      host: 'lb.internal.example.com',
      hostPort: 'lb.internal.example.com:443',
      basePath: '/v1',
    });
  });

  it('derives an empty base path for root URLs', () => {
    const resolved = resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'https://lb.internal/' });
    expect(resolved).toMatchObject({
      url: 'https://lb.internal',
      scheme: 'https',
      host: 'lb.internal',
      hostPort: 'lb.internal:443',
      basePath: '',
    });
  });

  it('accepts an explicit default port', () => {
    const resolved = resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'https://lb.internal:443/v1' });
    expect(resolved?.host).toBe('lb.internal');
    expect(resolved?.hostPort).toBe('lb.internal:443');
  });

  it('fails when the named variable is unset', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, {})).toThrow(/is not set/);
  });

  it('fails when the named variable is blank', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: '   ' })).toThrow(/is not set/);
  });

  it('rejects an invalid environment variable name', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv('1BAD NAME', {})).toThrow(
      /not a valid environment variable name/
    );
  });

  it('rejects a malformed URL without echoing the value', () => {
    const value = 'not a url secret-host.internal';
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: value })).toThrow(
      /does not contain a valid absolute URL/
    );
    try {
      resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: value });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-host.internal');
    }
  });

  it('rejects unsupported schemes', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'ftp://lb.internal' })).toThrow(
      /unsupported URL scheme/
    );
  });

  it('rejects http because the sidecar only supports HTTPS upstreams', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'http://lb.internal' })).toThrow(
      /Only https:\/\/ endpoints are supported/
    );
  });

  const credentialUrl = ['https://svc-user', ':', 's3cr3t-pw', '@lb.internal/v1'].join('');

  it('rejects embedded credentials', () => {
    expect(() =>
      resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: credentialUrl })
    ).toThrow(/embedded credentials/);
  });

  it('does not leak the value when rejecting embedded credentials', () => {
    try {
      resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: credentialUrl });
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('s3cr3t-pw');
      expect((error as Error).message).not.toContain('lb.internal');
    }
  });

  it('rejects query strings and fragments', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'https://lb.internal/v1?a=1' })).toThrow(
      /query string or fragment/
    );
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'https://lb.internal/v1#x' })).toThrow(
      /query string or fragment/
    );
  });

  it('rejects non-default ports because the sidecar cannot route them', () => {
    expect(() => resolveOpenAiBaseUrlFromEnv(VAR, { [VAR]: 'https://lb.internal:8443/v1' })).toThrow(
      /non-default port/
    );
  });

  it('reads from process.env by default', () => {
    const previous = process.env[VAR];
    process.env[VAR] = 'https://from-process-env.internal/v1';
    try {
      expect(resolveOpenAiBaseUrlFromEnv(VAR)?.host).toBe('from-process-env.internal');
    } finally {
      if (previous === undefined) delete process.env[VAR];
      else process.env[VAR] = previous;
    }
  });
});
