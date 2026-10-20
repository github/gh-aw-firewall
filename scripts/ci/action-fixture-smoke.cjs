const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '../..');
const action = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8'));
const install = action.runs.steps.find(step => step.id === 'install').run;
const pull = action.runs.steps.find(step => step.name === 'Pull Docker images').run;

function fixture() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-action-smoke-'));
  const env = {
    ...process.env,
    RUNNER_TEMP: work,
    GITHUB_PATH: path.join(work, 'path'),
    GITHUB_ENV: path.join(work, 'env'),
    GITHUB_OUTPUT: path.join(work, 'output'),
    GITHUB_TOKEN: 'isolated-fixture-token',
  };
  execFileSync(process.execPath, [path.join(__dirname, 'setup-action-test-fixtures.cjs')], { env, stdio: 'pipe' });
  for (const line of fs.readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n')) {
    const index = line.indexOf('=');
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  env.PATH = `${fs.readFileSync(env.GITHUB_PATH, 'utf8').trim()}:${process.env.PATH}`;
  return { work, env, dir: env.AWF_ACTION_FIXTURE_DIR };
}

test('isolated verifier checks signatures and all production provenance constraints', () => {
  const f = fixture();
  try {
    const args = ['attestation', 'verify', path.join(f.dir, 'assets/awf-linux-x64'),
      '--hostname', 'github.com', '--repo', 'github/gh-aw-firewall',
      '--signer-workflow', 'github/gh-aw-firewall/.github/workflows/release.yml',
      '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com', '--deny-self-hosted-runners'];
    const gh = path.join(f.dir, 'bin/gh');
    execFileSync(gh, args, { env: f.env, stdio: 'pipe' });
    for (const flag of ['--hostname', '--repo', '--signer-workflow', '--cert-oidc-issuer']) {
      const wrong = [...args];
      wrong[wrong.indexOf(flag) + 1] = 'unexpected-constraint';
      assert.notEqual(spawnSync(gh, wrong, { env: f.env }).status, 0);
    }
    assert.notEqual(spawnSync(gh, args.filter(arg => arg !== '--deny-self-hosted-runners'), { env: f.env }).status, 0);
    fs.appendFileSync(args[2], 'tampered');
    assert.notEqual(spawnSync(gh, args, { env: f.env }).status, 0);
    for (const reference of ['ghcr.io/github/gh-aw-firewall/squid:latest', `unknown@sha256:${'a'.repeat(64)}`]) {
      assert.notEqual(spawnSync(path.join(f.dir, 'bin/docker'), ['pull', reference], { env: f.env }).status, 0);
    }
  } finally {
    fs.rmSync(f.work, { recursive: true, force: true });
  }
});

test('real action shell succeeds for latest/specific/digest pulls and rejects legacy/tampered releases', {
  skip: process.platform !== 'linux',
}, () => {
  for (const scenario of ['latest', 'specific', 'images', 'legacy', 'tampered']) {
    const f = fixture();
    try {
      if (scenario === 'legacy') fs.unlinkSync(path.join(f.dir, 'assets/release-identity.txt'));
      if (scenario === 'tampered') fs.appendFileSync(path.join(f.dir, 'assets/awf-linux-x64'), 'tampered');
      const result = spawnSync('bash', ['-c', install], {
        env: { ...f.env, INPUT_VERSION: scenario === 'latest' ? 'latest' : 'v1.2.3' }, encoding: 'utf8',
      });
      if (['legacy', 'tampered'].includes(scenario)) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr + result.stdout,
          scenario === 'legacy' ? /Missing release identity/ : /provenance verification failed/);
        assert(!fs.existsSync(path.join(f.work, 'awf-bin/awf')));
        continue;
      }
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const version = execFileSync(path.join(f.work, 'awf-bin/awf'), ['--version'], { encoding: 'utf8' });
      assert.match(version, /v1\.2\.3/);
      assert.equal(fs.readFileSync(path.join(f.dir, 'verified.log'), 'utf8').trim().split('\n').length, 4);
      if (scenario === 'images') {
        const output = fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8');
        const imageTag = output.split('\n').find(line => line.startsWith('image_tag=')).slice('image_tag='.length);
        const pulled = spawnSync('bash', ['-c', pull], {
          env: { ...f.env, IMAGE_TAG: imageTag }, encoding: 'utf8',
        });
        assert.equal(pulled.status, 0, pulled.stderr + pulled.stdout);
        assert.deepEqual(fs.readFileSync(path.join(f.dir, 'pulled.log'), 'utf8').trim().split('\n'),
          fs.readFileSync(path.join(f.dir, 'assets/containers.txt'), 'utf8').trim().split('\n').slice(0, 2));
      }
    } finally {
      fs.rmSync(f.work, { recursive: true, force: true });
    }
  }
});
