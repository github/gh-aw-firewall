'use strict';

const { sanitizeAcceptEncoding } = require('./proxy-utils');

describe('sanitizeAcceptEncoding', () => {
  it('passes through supported encodings unchanged', () => {
    expect(sanitizeAcceptEncoding('gzip, deflate, br')).toBe('gzip, deflate, br');
  });

  it('strips zstd from the list', () => {
    expect(sanitizeAcceptEncoding('gzip, br, zstd')).toBe('gzip, br');
  });

  it('strips zstd with quality value', () => {
    expect(sanitizeAcceptEncoding('gzip;q=1.0, zstd;q=0.8, br;q=0.5')).toBe('gzip;q=1.0, br;q=0.5');
  });

  it('handles zstd-only Accept-Encoding by returning identity', () => {
    expect(sanitizeAcceptEncoding('zstd')).toBe('identity');
  });

  it('preserves identity encoding', () => {
    expect(sanitizeAcceptEncoding('identity, gzip, zstd')).toBe('identity, gzip');
  });

  it('returns defaults for empty/undefined input', () => {
    expect(sanitizeAcceptEncoding('')).toBe('gzip, deflate, br');
    expect(sanitizeAcceptEncoding(undefined)).toBe('gzip, deflate, br');
  });

  it('strips unknown encodings', () => {
    expect(sanitizeAcceptEncoding('gzip, compress, deflate')).toBe('gzip, deflate');
  });
});
