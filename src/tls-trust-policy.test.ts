import { X509Certificate } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { rootCertificates } from 'node:tls';

type Policy = typeof import('./tls-trust-policy');
const trusted = rootCertificates.find(pem => new X509Certificate(pem).subject.includes('ISRG Root X1'))!;
const blocked = readFileSync(path.resolve(__dirname, '../scripts/security/fixtures/emsign-ecc-g3.pem'), 'utf8').trim();
const originalExtraCa = process.env.NODE_EXTRA_CA_CERTS;
const originalNodeOptions = process.env.NODE_OPTIONS;
const originalSslCertFile = process.env.SSL_CERT_FILE;
const originalSslCertDir = process.env.SSL_CERT_DIR;

function load(options: {
  legacy?: boolean;
  defaults?: string[];
  extra?: string;
  opensslFile?: string;
  opensslDirectory?: string;
  opensslDirectoryCertificate?: string;
  missingOpenSslFile?: boolean;
  missingOpenSslDirectory?: boolean;
  missingOpenSslCertificate?: boolean;
  opensslDirectoryEntryIsFile?: boolean;
  opensslFileError?: Error;
  opensslDirectoryError?: Error;
  opensslCertificateError?: Error;
  opensslCertificateReadError?: Error;
  opensslDefaultDirectory?: string;
  opensslDefaultPathOutput?: string;
  extraError?: Error;
  setter?: boolean;
} = {}) {
  const nativeContext = {};
  const createSecureContext = jest.fn().mockReturnValue(nativeContext);
  const setDefaultCACertificates = jest.fn();
  const getCACertificates = jest.fn().mockReturnValue(options.defaults ?? [trusted, blocked]);
  const descriptors = new Map<number, string>();
  const open = jest.fn((filename: string) => {
    if (options.missingOpenSslCertificate) {
      throw Object.assign(new Error('certificate is missing'), { code: 'ENOENT' });
    }
    descriptors.set(42, filename);
    return 42;
  });
  const close = jest.fn();
  const inspect = jest.fn(() => {
    if (options.opensslCertificateError) throw options.opensslCertificateError;
    return { isFile: () => options.opensslDirectoryEntryIsFile !== false };
  });
  const read = jest.fn((input?: string | number) => {
    const filename = typeof input === 'number' ? descriptors.get(input) : input;
    if (options.extraError && filename === '/private-ca.pem') throw options.extraError;
    if (options.opensslFileError && filename === '/openssl-ca.pem') throw options.opensslFileError;
    if (filename === '/openssl-ca.pem' && options.missingOpenSslFile) {
      throw Object.assign(new Error('file is missing'), { code: 'ENOENT' });
    }
    if (options.opensslCertificateError && filename === '/openssl-certs/deadbeef.0') {
      throw options.opensslCertificateError;
    }
    if (options.opensslCertificateReadError && filename === '/openssl-certs/deadbeef.0') {
      throw options.opensslCertificateReadError;
    }
    if (filename === '/openssl-certs/deadbeef.0' && options.missingOpenSslCertificate) {
      throw Object.assign(new Error('certificate is missing'), { code: 'ENOENT' });
    }
    if (filename === '/openssl-certs/deadbeef.0') return options.opensslDirectoryCertificate;
    if (filename === '/openssl-default/certs/deadbeef.0') return options.opensslDirectoryCertificate;
    if (filename === '/private-ca.pem') return options.extra;
    return options.opensslFile;
  });
  const execFileSync = jest.fn(() => options.opensslDefaultPathOutput
    ?? `OPENSSLDIR: "${options.opensslDefaultDirectory ?? '/openssl-default'}"\n`);
  if (options.extra !== undefined || options.extraError) process.env.NODE_EXTRA_CA_CERTS = '/private-ca.pem';
  jest.doMock('node:tls', () => ({
    rootCertificates: options.defaults ?? [trusted, blocked],
    getCACertificates: options.legacy ? undefined : getCACertificates,
    setDefaultCACertificates: options.legacy || options.setter === false ? undefined : setDefaultCACertificates,
    createSecureContext,
  }));
  jest.doMock('node:fs', () => ({
    constants,
    openSync: open,
    closeSync: close,
    fstatSync: inspect,
    readFileSync: read,
    readdirSync: jest.fn((directory: string) => {
      if (options.opensslDirectoryError) throw options.opensslDirectoryError;
      if (options.missingOpenSslDirectory) {
        throw Object.assign(new Error('directory is missing'), { code: 'ENOENT' });
      }
      return options.opensslDirectory || directory === '/openssl-default/certs'
        ? ['deadbeef.0', 'README'] : [];
    }),
  }));
  jest.doMock('node:child_process', () => ({ execFileSync }));
  let policy!: Policy;
  let tls!: typeof import('node:tls');
  jest.isolateModules(() => {
    policy = jest.requireActual<Policy>('./tls-trust-policy');
    tls = jest.requireMock<typeof import('node:tls')>('node:tls');
  });
  return {
    policy, tls, createSecureContext, setDefaultCACertificates, getCACertificates, read, execFileSync, nativeContext,
    open, close, inspect,
  };
}

beforeEach(() => {
  jest.resetModules();
  delete process.env.NODE_EXTRA_CA_CERTS;
});
afterEach(() => {
  jest.dontMock('node:tls');
  jest.dontMock('node:fs');
  jest.dontMock('node:child_process');
  if (originalExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  if (originalSslCertFile === undefined) delete process.env.SSL_CERT_FILE;
  else process.env.SSL_CERT_FILE = originalSslCertFile;
  if (originalSslCertDir === undefined) delete process.env.SSL_CERT_DIR;
  else process.env.SSL_CERT_DIR = originalSslCertDir;
});

test('checks and reads each hashed CA through the same opened descriptor', () => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const f = load({ legacy: true, opensslFile: trusted, opensslDirectory: '/openssl-certs',
    opensslDirectoryCertificate: trusted });
  expect(f.open).toHaveBeenCalledWith('/openssl-certs/deadbeef.0', constants.O_RDONLY | constants.O_NONBLOCK);
  expect(f.inspect).toHaveBeenCalledWith(42);
  expect(f.read).toHaveBeenCalledWith(42, 'utf8');
  expect(f.read).not.toHaveBeenCalledWith('/openssl-certs/deadbeef.0', 'utf8');
  expect(f.close).toHaveBeenCalledWith(42);
});

test.each(['stat', 'read'])('closes the hashed CA descriptor when %s fails', source => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const error = Object.assign(new Error('hashed CA I/O failed'), { code: 'EIO' });
  expect(() => load({
    legacy: true, opensslFile: trusted, opensslDirectory: '/openssl-certs',
    opensslCertificateError: source === 'stat' ? error : undefined,
    opensslCertificateReadError: source === 'read' ? error : undefined,
  })).toThrow('hashed CA I/O failed');
  expect(jest.requireMock<typeof import('node:fs')>('node:fs').closeSync).toHaveBeenCalledWith(42);
});

test('closes but never reads a non-regular hashed CA entry', () => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const f = load({ legacy: true, opensslFile: trusted, opensslDirectory: '/openssl-certs',
    opensslDirectoryEntryIsFile: false });
  expect(f.open).toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalledWith(42, 'utf8');
  expect(f.close).toHaveBeenCalledWith(42);
});

test('filters modern defaults and extra roots and installs the policy only once', () => {
  const f = load({ extra: blocked + '\n' + trusted });
  expect(f.getCACertificates).toHaveBeenCalledWith('default');
  expect(f.read).toHaveBeenCalledWith('/private-ca.pem', 'utf8');
  expect(f.setDefaultCACertificates).toHaveBeenCalledWith([trusted, trusted]);
  f.policy.applyTlsTrustPolicy();
  expect(f.setDefaultCACertificates).toHaveBeenCalledTimes(1);
});

test.each([false, true])('default and null CA options use sanitized defaults (legacy=%s)', legacy => {
  const f = load({ legacy });
  for (const options of [undefined, null, { ca: null }, { ca: '' }]) {
    // Node accepts ca:null at runtime, despite its declaration excluding null.
    const result = options === undefined
      ? f.tls.createSecureContext()
      : Reflect.apply(f.tls.createSecureContext, f.tls, [options]);
    expect(result).toBe(f.nativeContext);
    expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [trusted] });
  }
  expect(f.setDefaultCACertificates).toHaveBeenCalledTimes(legacy ? 0 : 1);
});

test.each([false, true])('preserves OpenSSL-selected CA sources instead of bundled roots (legacy=%s)', legacy => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const f = load({
    legacy,
    opensslFile: blocked,
    opensslDirectory: '/openssl-certs',
    opensslDirectoryCertificate: trusted,
  });
  expect(f.read).toHaveBeenCalledWith('/openssl-ca.pem', 'utf8');
  expect(f.getCACertificates).not.toHaveBeenCalled();
  expect(f.open).toHaveBeenCalledWith('/openssl-certs/deadbeef.0', constants.O_RDONLY | constants.O_NONBLOCK);
  expect(f.read).toHaveBeenCalledWith(42, 'utf8');
  f.tls.createSecureContext();
  expect(f.createSecureContext).toHaveBeenCalledWith({ ca: [trusted] });
});

test('legacy Node discovers OpenSSL default CA paths when build metadata omits them', () => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  delete process.env.SSL_CERT_FILE;
  delete process.env.SSL_CERT_DIR;
  const f = load({
    legacy: true,
    opensslFile: blocked,
    opensslDirectory: '/openssl-default/certs',
    opensslDirectoryCertificate: trusted,
  });
  expect(f.execFileSync).toHaveBeenCalledWith('openssl', ['version', '-d'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  expect(f.read).toHaveBeenCalledWith('/openssl-default/cert.pem', 'utf8');
  f.tls.createSecureContext();
  expect(f.createSecureContext).toHaveBeenCalledWith({ ca: [trusted] });
});

test.each([
  ['unreadable file', 'file'],
  ['unreadable directory', 'directory'],
  ['unreadable hashed certificate', 'certificate'],
])('fails closed on an %s in the selected OpenSSL trust store', (_label, source) => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  expect(() => load({
    legacy: true,
    opensslFile: trusted,
    opensslDirectory: '/openssl-certs',
    opensslDirectoryCertificate: trusted,
    opensslFileError: source === 'file' ? error : undefined,
    opensslDirectoryError: source === 'directory' ? error : undefined,
    opensslCertificateError: source === 'certificate' ? error : undefined,
  })).toThrow('permission denied');
});

test('fails closed when OpenSSL default directory cannot be discovered', () => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  delete process.env.SSL_CERT_FILE;
  delete process.env.SSL_CERT_DIR;
  expect(() => load({ legacy: true, opensslDefaultPathOutput: 'no OPENSSLDIR here' }))
    .toThrow('Unable to determine OpenSSL default CA paths');
});

test('fails closed when the selected OpenSSL sources contain no readable CA certificates', () => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  expect(() => load({
    legacy: true,
    opensslDirectory: '/openssl-certs',
    opensslDirectoryEntryIsFile: false,
  })).toThrow('empty default CA store');
});

test.each(['file', 'directory', 'certificate'])('ignores missing OpenSSL trust path %s when another source is available', missing => {
  process.env.NODE_OPTIONS = '--use-openssl-ca';
  process.env.SSL_CERT_FILE = '/openssl-ca.pem';
  process.env.SSL_CERT_DIR = '/openssl-certs';
  const f = load({
    legacy: true,
    opensslFile: trusted,
    opensslDirectory: '/openssl-certs',
    opensslDirectoryCertificate: trusted,
    missingOpenSslFile: missing === 'file',
    missingOpenSslDirectory: missing === 'directory',
    missingOpenSslCertificate: missing === 'certificate',
  });
  f.tls.createSecureContext();
  expect(f.createSecureContext).toHaveBeenCalledWith({ ca: [trusted] });
});

test('filters explicit CA strings, buffers and arrays without dropping other options', () => {
  const f = load({ setter: false });
  for (const ca of [trusted + '\n' + blocked, Buffer.from(trusted), [Buffer.from(blocked), trusted]]) {
    f.tls.createSecureContext({ ca, minVersion: 'TLSv1.2' });
    expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [trusted], minVersion: 'TLSv1.2' });
  }
  f.tls.createSecureContext({ ca: blocked });
  expect(f.createSecureContext).toHaveBeenLastCalledWith({ ca: [] });
  expect(f.policy.filterCaCertificates(' \n')).toEqual([]);
});

test.each([
  ['not a certificate', /PEM CERTIFICATE/],
  ['-----BEGIN TRUSTED CERTIFICATE-----\ninvalid\n-----END TRUSTED CERTIFICATE-----', /PEM CERTIFICATE/],
  ['-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----', /./],
])('rejects malformed explicit trust: %s', (ca, error) => {
  const f = load();
  expect(() => f.tls.createSecureContext({ ca })).toThrow(error);
  expect(f.createSecureContext).not.toHaveBeenCalled();
});

test.each([false, true])('rejects an entirely distrusted default store (legacy=%s)', legacy => {
  expect(() => load({ legacy, defaults: [blocked] })).toThrow('empty default CA store');
});

test('fails closed when an explicit extra CA file cannot be read', () => {
  expect(() => load({ extraError: new Error('private CA is unreadable') })).toThrow('private CA is unreadable');
});
