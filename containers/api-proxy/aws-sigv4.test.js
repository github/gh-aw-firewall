'use strict';

const {
  canonicalizePath,
  canonicalizeQuery,
  signAwsRequest,
} = require('./aws-sigv4');

describe('AWS SigV4 signing', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    sessionToken: 'session-token-example',
  };

  test('signs method, path, sorted query, body hash, host, region, and service', () => {
    const headers = signAwsRequest({
      credentials,
      region: 'us-east-1',
      service: 'bedrock-runtime',
      method: 'POST',
      path: '/model/anthropic.claude-v2/invoke?z=last&a=hello%20world&a=first',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"prompt":"Hello"}'),
      targetHost: 'bedrock-runtime.us-east-1.amazonaws.com',
      now: new Date('2024-01-02T03:04:05.000Z'),
    });

    expect(headers).toEqual({
      'content-type': 'application/json',
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      'x-amz-content-sha256': 'fa15bd108b18eb610f5410b1446e7c2c59e0656c6c8eb42321a9c8ad65358450',
      'x-amz-date': '20240102T030405Z',
      'x-amz-security-token': 'session-token-example',
      Authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240102/us-east-1/bedrock-runtime/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, ' +
        'Signature=839d2e015ef6dbda647df1efb61512a3ac993e86d592d92d465980ceba0aa9a4',
    });
  });

  test('canonicalizes encoded path segments and duplicate query parameters', () => {
    expect(canonicalizePath('/model/my%20model/invoke')).toBe('/model/my%20model/invoke');
    expect(canonicalizeQuery('z=last&a=hello+world&a=first&empty')).toBe(
      'a=first&a=hello%2Bworld&empty=&z=last',
    );
  });

  test('replaces stale signing headers when a request is retried', () => {
    const headers = signAwsRequest({
      credentials,
      region: 'us-east-1',
      method: 'POST',
      path: '/model/test/invoke',
      headers: {
        Authorization: 'stale',
        Host: 'stale.example.com',
        'X-Amz-Date': '20000101T000000Z',
        'X-Amz-Security-Token': 'stale-token',
        'X-Amz-Content-Sha256': 'stale-hash',
      },
      body: Buffer.from('{}'),
      targetHost: 'bedrock-runtime.us-east-1.amazonaws.com',
      now: new Date('2024-01-02T03:04:05.000Z'),
    });

    expect(headers.Authorization).toContain('Credential=AKIDEXAMPLE/');
    expect(headers['x-amz-security-token']).toBe('session-token-example');
    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  test('fails closed when temporary credentials are incomplete', () => {
    expect(() => signAwsRequest({
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      region: 'us-east-1',
      method: 'GET',
      path: '/',
      targetHost: 'bedrock-runtime.us-east-1.amazonaws.com',
    })).toThrow('AWS temporary credentials are unavailable');
  });
});
