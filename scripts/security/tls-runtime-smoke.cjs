// Dependency-free regression for the actual Node runtime used by each image.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('image launcher retains policy when NODE_OPTIONS is replaced and in child Node processes', {
  skip: !fs.existsSync('/usr/local/bin/node-awf'),
}, () => {
  const script = `
    const tls=require('tls'),{X509Certificate}=require('crypto'),assert=require('assert');
    const check="const tls=require('tls'),{X509Certificate}=require('crypto');"+
      "console.log(tls.getCACertificates('default').some(pem=>new X509Certificate(pem).subject.includes('emSign ECC Root CA - G3')))";
    assert(!tls.getCACertificates('default').some(pem=>new X509Certificate(pem).subject.includes('emSign ECC Root CA - G3')));
    assert.equal(require('child_process').execFileSync(process.execPath,['-e',check],{encoding:'utf8'}).trim(),'false');
  `;
  execFileSync('/usr/local/bin/node', ['-e', script], {
    env: {
      ...process.env, NODE_OPTIONS: '',
      NODE_EXTRA_CA_CERTS: path.resolve(__dirname, 'fixtures/emsign-ecc-g3.pem'),
    },
    stdio: 'pipe',
  });
});

test('HTTPS, direct TLS and fetch enforce default, extra and explicit CA distrust', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-node-trust-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: work, stdio: 'pipe' });
  const read = name => fs.readFileSync(path.join(work, name), 'utf8');
  const servers = [];
  try {
    for (const name of ['blocked', 'private-awf']) {
      run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${name}`,
        '-keyout', `${name}.key`, '-out', `${name}.pem`, '-addext', 'basicConstraints=critical,CA:TRUE');
      fs.writeFileSync(path.join(work, 'leaf.ext'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
      run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
        '-keyout', `${name}-leaf.key`, '-out', `${name}-leaf.csr`);
      run('x509', '-req', '-in', `${name}-leaf.csr`, '-CA', `${name}.pem`, '-CAkey', `${name}.key`,
        '-CAcreateserial', '-days', '2', '-extfile', 'leaf.ext', '-out', `${name}-leaf.pem`);
    }
    const key = new X509Certificate(read('blocked.pem')).publicKey.export({ format: 'der', type: 'spki' });
    const hash = createHash('sha256').update(key).digest('hex');
    const policy = fs.readFileSync(path.resolve(__dirname, '../../containers/trust/node-trust.cjs'), 'utf8')
      .replace('43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b', hash);
    fs.writeFileSync(path.join(work, 'policy.cjs'), policy);
    fs.writeFileSync(path.join(work, 'inputs.pem'), read('blocked.pem') + read('private-awf.pem'));
    for (const name of ['blocked', 'private-awf']) {
      const server = https.createServer({ key: read(`${name}-leaf.key`), cert: read(`${name}-leaf.pem`) },
        (_req, res) => res.end('ok'));
      servers.push(server);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      for (const mode of ['https', 'tls', 'fetch']) {
        for (const explicit of [false, true, null]) {
          const allowed = name === 'private-awf';
          const script = `
            const fs = require('fs');
            const mode = process.env.AWF_MODE;
            const port = Number(process.env.AWF_PORT);
            const explicit = process.env.AWF_EXPLICIT === '1';
            const allowed = process.env.AWF_ALLOWED === '1';
            const options = { host: '127.0.0.1', port, servername: 'localhost' };
            if (explicit) options.ca = fs.readFileSync(process.env.AWF_INPUTS_PEM);
            else if (process.env.AWF_EXPLICIT === 'null') options.ca = null;
            const fail = () => process.exit(allowed ? 1 : 0);
            const pass = () => process.exit(allowed ? 0 : 1);
            if (mode === 'tls') require('tls').connect(options, pass).on('error', fail);
            else if (mode === 'fetch') fetch('https://localhost:' + port).then(pass, fail);
            else require('https').get(options, pass).on('error', fail);
            setTimeout(() => process.exit(2), 5000).unref();
          `;
          const code = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--require', path.join(work, 'policy.cjs'), '-e', script], {
              env: {
                ...process.env,
                NODE_EXTRA_CA_CERTS: path.join(work, 'inputs.pem'),
                AWF_MODE: mode,
                AWF_PORT: String(port),
                AWF_EXPLICIT: explicit === null ? 'null' : explicit ? '1' : '0',
                AWF_ALLOWED: allowed ? '1' : '0',
                AWF_INPUTS_PEM: path.join(work, 'inputs.pem'),
              },
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', status => status === 0
              ? resolve(status) : reject(new Error(`${mode}/${name}/explicit=${explicit}: ${stderr} (exit ${status})`)));
          });
          assert.equal(code, 0);
        }
      }
    }
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(work, { recursive: true, force: true });
  }
});
