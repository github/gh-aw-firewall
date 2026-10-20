import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';

const root = path.resolve(__dirname, '../..');
const policyDir = path.join(root, 'containers/trust');
const { extractDistrustedSpkis } = jest.requireActual<{
  extractDistrustedSpkis: (source: string) => string[];
}>('./generate-trust-policy.cjs');
let work: string;
let blockedRoot: string;
let goodRoot: string;
let blockedKey: string;

function openssl(...args: string[]): string {
  return execFileSync('openssl', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function spki(pem: string): string {
  return createHash('sha256').update(
    new X509Certificate(pem).publicKey.export({ format: 'der', type: 'spki' }),
  ).digest('hex');
}

function makeRoot(name: string): string {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-addext', 'basicConstraints=critical,CA:TRUE');
  return fs.readFileSync(path.join(work, `${name}.pem`), 'utf8');
}

function makeLeaf(name: string, issuer: string): void {
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-keyout', `${name}.key`, '-out', `${name}.csr`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`,
    '-CAkey', `${issuer}.key`, '-CAcreateserial', '-days', '2',
    '-extfile', 'leaf.ext', '-out', `${name}.pem`);
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-trust-test-'));
  blockedRoot = makeRoot('blocked');
  goodRoot = makeRoot('private-awf');
  blockedKey = spki(blockedRoot);
  fs.writeFileSync(path.join(work, 'leaf.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
  makeLeaf('bad-leaf', 'blocked');
  makeLeaf('good-leaf', 'private-awf');
  fs.writeFileSync(path.join(work, 'inputs.pem'), blockedRoot + goodRoot);
  fs.copyFileSync(path.join(policyDir, 'filter-ca-store.sh'), path.join(work, 'filter-ca-store.sh'));
  fs.writeFileSync(path.join(work, 'distrusted-spki.txt'), `${blockedKey}\n`);
  // Exercise production policy code with a generated, offline compromised key.
  const policy = fs.readFileSync(path.join(policyDir, 'node-trust.cjs'), 'utf8')
    .replace('43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b', blockedKey);
  fs.writeFileSync(path.join(work, 'policy.cjs'), policy);
}, 30000);

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

test('generated Docker trust policies remain synchronized with canonical TypeScript', () => {
  execFileSync(process.execPath, ['scripts/security/generate-trust-policy.cjs', '--check'], { cwd: root });
});

test('trust policy generator parses validated SPKI literals independent of quote style', () => {
  const keys = ['a'.repeat(64), 'b'.repeat(64)];
  for (const quote of ["'", '"']) {
    const entries = keys.map(key => `${quote}${key}${quote}`).join(', ');
    expect(extractDistrustedSpkis(`export const distrustedSpkis = new Set([${entries}]);`)).toEqual(keys);
  }
});

test.each([
  'export const distrustedSpkis = new Set([]);',
  `export const distrustedSpkis = new Set(['${'a'.repeat(63)}']);`,
  `export const distrustedSpkis = new Set(['${'a'.repeat(64)}', '${'a'.repeat(64)}']);`,
  `export const distrustedSpkis = new Set([...'${'a'.repeat(64)}']);`,
  `export const other = new Set(['${'a'.repeat(64)}']);`,
])('trust policy generator rejects malformed canonical hash declarations', source => {
  expect(() => extractDistrustedSpkis(source)).toThrow();
});

test('dependency-free runtime transport smoke also runs in the root regression suite', () => {
  execFileSync(process.execPath, ['--test', 'scripts/security/tls-runtime-smoke.cjs'], { cwd: root, stdio: 'pipe' });
}, 30000);

test('known compromised and root SPKIs are all present and valid', () => {
  const keys = fs.readFileSync(path.join(policyDir, 'distrusted-spki.txt'), 'utf8').trim().split('\n');
  expect(new Set(keys).size).toBe(12);
  expect(keys.every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  expect(keys).toContain('8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782');
  expect(keys).toContain('bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3');
});

test('filters bundles and hashed directories without modifying input trust', () => {
  const inputDir = path.join(work, 'input-certs');
  fs.mkdirSync(inputDir);
  fs.writeFileSync(path.join(inputDir, 'blocked.pem'), blockedRoot);
  fs.writeFileSync(path.join(inputDir, 'private.pem'), goodRoot);
  openssl('rehash', inputDir);
  const original = fs.readFileSync(path.join(work, 'inputs.pem'), 'utf8');
  const output = path.join(work, 'filtered');
  execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), output, inputDir, path.join(work, 'inputs.pem')]);
  const bundle = fs.readFileSync(path.join(output, 'ca-certificates.crt'), 'utf8');
  expect(bundle).toContain(goodRoot.trim());
  expect(bundle).not.toContain(blockedRoot.trim());
  expect(fs.readFileSync(path.join(work, 'inputs.pem'), 'utf8')).toBe(original);
  expect(openssl('verify', '-CAfile', path.join(output, 'ca-certificates.crt'),
    '-CApath', path.join(output, 'certs'), 'good-leaf.pem')).toContain('OK');
  expect(() => openssl('verify', '-CAfile', path.join(output, 'ca-certificates.crt'),
    '-CApath', path.join(output, 'certs'), 'bad-leaf.pem')).toThrow();
  // A same-key cross-sign has a different certificate fingerprint but is removed.
  openssl('req', '-new', '-key', 'blocked.key', '-subj', '/CN=cross-signed', '-out', 'cross.csr');
  fs.writeFileSync(path.join(work, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\n');
  openssl('x509', '-req', '-in', 'cross.csr', '-CA', 'private-awf.pem', '-CAkey', 'private-awf.key',
    '-CAcreateserial', '-days', '2', '-extfile', 'ca.ext', '-out', 'cross.pem');
  const cross = fs.readFileSync(path.join(work, 'cross.pem'), 'utf8');
  expect(spki(cross)).toBe(blockedKey);
  fs.writeFileSync(path.join(work, 'cross-bundle.pem'), cross + goodRoot);
  execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), path.join(work, 'cross-output'),
    path.join(work, 'cross-bundle.pem')]);
  expect(fs.readFileSync(path.join(work, 'cross-output/ca-certificates.crt'), 'utf8')).not.toContain(cross.trim());
});

test('deduplicates identical PEM blocks before invoking OpenSSL', () => {
  const inputDir = path.join(work, 'duplicate-input');
  const fakeBin = path.join(work, 'counting-bin');
  const calls = path.join(work, 'openssl-calls');
  fs.mkdirSync(inputDir);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(inputDir, 'same.pem'), goodRoot);
  fs.writeFileSync(path.join(inputDir, 'ca-certificates.crt'), goodRoot);
  openssl('rehash', inputDir);
  const realOpenSsl = execFileSync('which', ['openssl'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(fakeBin, 'openssl'),
    '#!/bin/sh\ncase "$1" in x509|pkey|dgst) printf "%s\\n" "$1" >> "$AWF_OPENSSL_CALLS";; esac\nexec "$AWF_REAL_OPENSSL" "$@"\n');
  fs.chmodSync(path.join(fakeBin, 'openssl'), 0o755);
  execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), path.join(work, 'deduplicated-output'),
    inputDir], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AWF_OPENSSL_CALLS: calls,
      AWF_REAL_OPENSSL: realOpenSsl,
    },
  });
  expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(5);
});

test('invalid and all-distrusted CA stores fail closed', () => {
  fs.writeFileSync(path.join(work, 'invalid.pem'), 'not a certificate');
  fs.writeFileSync(path.join(work, 'only-blocked.pem'), blockedRoot);
  for (const input of ['invalid.pem', 'only-blocked.pem', 'missing.pem']) {
    expect(() => execFileSync('sh', [path.join(work, 'filter-ca-store.sh'),
      path.join(work, `reject-${input}`), path.join(work, input)], { stdio: 'pipe' })).toThrow();
  }
});

test('missing, empty, and grep-error distrust policies fail closed', () => {
  const policyFile = path.join(work, 'distrusted-spki.txt');
  const policy = fs.readFileSync(policyFile, 'utf8');
  const output = path.join(work, 'reject-policy');
  try {
    fs.unlinkSync(policyFile);
    expect(() => execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), output,
      path.join(work, 'inputs.pem')], { stdio: 'pipe' })).toThrow();

    fs.writeFileSync(policyFile, '');
    expect(() => execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), output,
      path.join(work, 'inputs.pem')], { stdio: 'pipe' })).toThrow();

    fs.writeFileSync(policyFile, policy);
    const fakeBin = path.join(work, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const fakeGrep = path.join(fakeBin, 'grep');
    fs.writeFileSync(fakeGrep, '#!/bin/sh\nexit 2\n');
    fs.chmodSync(fakeGrep, 0o755);
    expect(() => execFileSync('sh', [path.join(work, 'filter-ca-store.sh'), output,
      path.join(work, 'inputs.pem')], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stdio: 'pipe',
    })).toThrow();
    expect(fs.existsSync(path.join(output, 'ca-certificates.crt'))).toBe(false);
  } finally {
    fs.writeFileSync(policyFile, policy);
  }
});

test.each(['https', 'tls', 'fetch'])('%s rejects compromised default/extra/explicit trust and keeps private CA support', async mode => {
  for (const [leaf, allowed] of [['bad-leaf', false], ['good-leaf', true]] as const) {
    const server = https.createServer({
      key: fs.readFileSync(path.join(work, `${leaf}.key`)),
      cert: fs.readFileSync(path.join(work, `${leaf}.pem`)),
    }, (_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    try {
      for (const explicit of [false, true]) {
        const script = `
          const fs = require('fs');
          const options = {host:'127.0.0.1', port:${address.port}, servername:'localhost',
            ${explicit ? `ca:fs.readFileSync(${JSON.stringify(path.join(work, 'inputs.pem'))}),` : ''}};
          const fail = () => process.exit(${allowed ? 1 : 0});
          const pass = () => process.exit(${allowed ? 0 : 1});
          if (${JSON.stringify(mode)} === 'tls') {
            require('tls').connect(options, pass).on('error', fail);
          } else if (${JSON.stringify(mode)} === 'fetch') {
            // Fetch uses the filtered default store; explicit CA is exercised by https/tls.
            fetch('https://localhost:${address.port}').then(pass, fail);
          } else {
            require('https').get(options, pass).on('error', fail);
          }
          setTimeout(() => process.exit(2), 5000).unref();
        `;
        const status = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(process.execPath, ['--require', path.join(work, 'policy.cjs'), '-e', script], {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(work, 'inputs.pem') },
            stdio: 'pipe',
          });
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve(code) : reject(new Error(`${mode}/${leaf}: ${stderr} (exit ${code})`)));
        });
        expect(status).toBe(0);
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}, 30000);

test('Node preserves private roots selected by OpenSSL', async () => {
  for (const [leaf, allowed] of [['bad-leaf', false], ['good-leaf', true]] as const) {
    const server = https.createServer({
      key: fs.readFileSync(path.join(work, `${leaf}.key`)),
      cert: fs.readFileSync(path.join(work, `${leaf}.pem`)),
    }, (_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    try {
      const script = `
        const fail = () => process.exit(${allowed ? 1 : 0});
        const pass = () => process.exit(${allowed ? 0 : 1});
        require('https').get({host:'127.0.0.1', port:${address.port}, servername:'localhost'}, pass).on('error', fail);
        setTimeout(() => process.exit(2), 5000).unref();
      `;
      const status = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--use-openssl-ca', '--require', path.join(work, 'policy.cjs'), '-e', script,
        ], {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: '',
            SSL_CERT_FILE: path.join(work, 'inputs.pem'),
            SSL_CERT_DIR: '',
          },
          stdio: 'pipe',
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0
          ? resolve(code) : reject(new Error(`OpenSSL-selected trust child failed for ${leaf}: ${stderr} (exit ${code})`)));
      });
      expect(status).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}, 30000);

const defaultCaApisAvailable = typeof tls.getCACertificates === 'function'
  && typeof tls.setDefaultCACertificates === 'function';
const testDefaultCaInspection = defaultCaApisAvailable ? test : test.skip;

testDefaultCaInspection('Node defaults no longer contain emergency-distrusted roots', () => {
  const script = `
    const tls = require('tls'), {X509Certificate,createHash} = require('crypto'), assert = require('assert');
    const original = tls.createSecureContext;
    let appliedCa;
    tls.createSecureContext = options => { appliedCa = options.ca; return original(options); };
    const {distrustedSpkis} = require(${JSON.stringify(path.join(policyDir, 'node-trust.cjs'))});
    for (const options of [{}, {ca:null}]) {
      tls.createSecureContext(options);
      assert(Array.isArray(appliedCa) && appliedCa.length > 0);
      for (const pem of [...appliedCa, ...(tls.getCACertificates?.('default') || [])]) {
        const key = new X509Certificate(pem).publicKey.export({format:'der',type:'spki'});
        assert(!distrustedSpkis.has(createHash('sha256').update(key).digest('hex')));
      }
    }
  `;
  execFileSync(process.execPath, ['-e', script]);
});

test('all gh builds use the fixed Go toolchain and assert compiled metadata', () => {
  for (const component of ['agent', 'cli-proxy', 'build-tools']) {
    const dockerfile = fs.readFileSync(path.join(root, 'containers', component, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd');
    expect(dockerfile).toContain("go version -m bin/gh | head -n 1 | grep -Eq ': go1\\.27\\.3$'");
  }
});

test('every controlled image wires the policy from its actual build context', () => {
  for (const component of ['agent', 'api-proxy', 'cli-proxy', 'build-tools', 'gh-aw-node',
    'router', 'dind-ubuntu', 'squid', 'enclave', 'cloud-hypervisor']) {
    const dockerfile = fs.readFileSync(path.join(root, 'containers', component, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY trust/ /opt/awf/trust/');
    expect(dockerfile).toContain('sh /opt/awf/trust/install-system-trust.sh');
    if (!['squid', 'router', 'build-tools'].includes(component)) {
      expect(dockerfile).toContain('sh /opt/awf/trust/install-node-trust.sh');
    }
  }
  const minimal = fs.readFileSync(path.join(root, 'containers/agent/Dockerfile.minimal'), 'utf8');
  expect(minimal).toContain('COPY trust/ /opt/awf/trust/');
  expect(minimal).toContain('openssl ca-certificates');
  const routerIgnore = fs.readFileSync(path.join(root, 'containers/router/.dockerignore'), 'utf8');
  expect(routerIgnore).toContain('!trust/**');
  for (const component of ['cli-proxy', 'api-proxy', 'squid', 'router']) {
    const dockerfile = fs.readFileSync(path.join(root, 'containers', component, 'Dockerfile'), 'utf8');
    expect(dockerfile.lastIndexOf('sh /opt/awf/trust/install-system-trust.sh'))
      .toBeLessThan(dockerfile.lastIndexOf('\nUSER '));
  }
});
