#!/usr/bin/env node
// Run after npm run build. Supply the unmodified, pinned upstream security.ts;
// execution is offline in disposable Linux containers, without provider secrets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { buildGeminiSettingsService, GEMINI_SETTINGS_SERVICE, GEMINI_SETTINGS_VOLUME } =
  require('../../dist/services/gemini-settings-service.js');
const { buildGeminiCredentialEnv } = require('../../dist/services/credentials/gemini-credential-env.js');
const { getGeminiSystemSettingsPath } = require('../../dist/services/credentials/gemini-cli-settings.js');

// Gemini CLI v0.64.0, commit 4a0749aceac5643e6f85a36d7420314d85e13b52.
const sourceSha256 = '2b314e13784379d11bf6401a9f4d54f90655f8ecd63826ec8d9cb569cd98ffc5';
assert(process.argv[2], 'Usage: node scripts/ci/gemini-system-settings-smoke.mjs /absolute/path/to/security.ts');
const source = fs.readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), sourceSha256, 'Unexpected upstream validator source');
const image = process.env.AWF_GEMINI_TEST_IMAGE || 'node:24-bookworm';
const project = `awf-gemini-${randomUUID()}`;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gemini-secure-path-'));
fs.chmodSync(workDir, 0o755);

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const composePlugin = run('docker', ['compose', 'version'], true);
const composeCommand = composePlugin.status === 0 ? 'docker' : 'docker-compose';
const composePrefix = composePlugin.status === 0 ? ['compose'] : [];
function compose(args, allowFailure = false) {
  return run(composeCommand, [
    ...composePrefix, '--project-name', project, '--file', path.join(workDir, 'compose.json'), ...args,
  ], allowFailure);
}

function prepareFixtures() {
  const fs = require('node:fs');
  const path = require('node:path');
  const write = (file, { uid = 0, mode = 0o644 } = {}) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, '{}', { mode });
    fs.chownSync(file, uid, uid);
    fs.chmodSync(file, mode);
  };
  for (const dir of ['/fixtures', '/home/runner']) {
    fs.chownSync(dir, 0, 0);
    fs.chmodSync(dir, 0o755);
  }
  write('/home/runner/.awf/gemini-cli-system-settings.json', { uid: 1001 });
  fs.chownSync('/home/runner', 1001, 1001);
  fs.chownSync('/home/runner/.awf', 1001, 1001);
  write('/home/runner/root-leaf/settings.json');
  for (const [name, mode] of [['group-writable', 0o775], ['world-writable', 0o777], ['non-root', 0o755]]) {
    write(`/fixtures/${name}/settings.json`);
    fs.chmodSync(`/fixtures/${name}`, mode);
    if (name === 'non-root') fs.chownSync(`/fixtures/${name}`, 1001, 1001);
  }
  write('/fixtures/secure/plain.json');
  write('/fixtures/secure/group-writable.json', { mode: 0o664 });
  write('/fixtures/secure/world-writable.json', { mode: 0o646 });
  fs.symlinkSync('/fixtures/secure/plain.json', '/fixtures/secure/user-link.json');
  fs.lchownSync('/fixtures/secure/user-link.json', 1001, 1001);
  fs.symlinkSync('/fixtures/secure', '/fixtures/user-parent');
  fs.lchownSync('/fixtures/user-parent', 1001, 1001);
  fs.symlinkSync('/fixtures/non-root', '/fixtures/secure/canonical-escape');
}

async function verifySettings(settingsPath, isFileAndDirectorySecureSync) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const http = require('node:http');
  assert.equal(process.getuid(), 1001);
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^CapEff:\s+0+$/m);
  const check = (file) => {
    assert(fs.existsSync(file), `Missing fixture: ${file}`);
    // The real upstream POSIX validator uses Map's has/get/set interface.
    // Supplying a cache avoids the unrelated third-party LRU implementation.
    return isFileAndDirectorySecureSync(file, new Map());
  };
  assert.equal(check(settingsPath).secure, true);
  assert.equal(check('/fixtures/secure/plain.json').secure, true);
  for (const [file, mode] of [[settingsPath, 0o644], ['/etc/awf/gemini-cli', 0o755]]) {
    const stat = fs.statSync(file);
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, 0);
    assert.equal(stat.mode & 0o777, mode);
  }
  assert.equal(fs.statSync('/home/runner').uid, 1001);
  for (const file of [
    '/home/runner/.awf/gemini-cli-system-settings.json',
    '/home/runner/root-leaf/settings.json',
    '/fixtures/group-writable/settings.json',
    '/fixtures/world-writable/settings.json',
    '/fixtures/non-root/settings.json',
    '/fixtures/secure/group-writable.json',
    '/fixtures/secure/world-writable.json',
    '/fixtures/secure/user-link.json',
    '/fixtures/user-parent/plain.json',
    '/fixtures/secure/canonical-escape/settings.json',
  ]) {
    const result = check(file);
    assert.equal(result.secure, false, `Unexpected acceptance: ${file}`);
    assert(result.reason);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    security: { auth: { selectedType: 'gemini-api-key' } },
  });
  assert.throws(() => fs.appendFileSync(settingsPath, 'tamper'), { code: /EROFS|EACCES/ });
  assert.throws(() => fs.unlinkSync(settingsPath), { code: /EROFS|EACCES/ });
  assert.throws(() => fs.writeFileSync('/etc/awf/replacement', 'tamper'), { code: /EROFS|EACCES/ });
  fs.writeFileSync('/home/runner/writable-probe', 'home remains writable');
  fs.unlinkSync('/home/runner/writable-probe');
  assert.equal(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, settingsPath);
  assert.equal(process.env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:10003');
  assert.equal(process.env.GEMINI_API_BASE_URL, process.env.GOOGLE_GEMINI_BASE_URL);
  assert.equal(process.env.GEMINI_API_KEY, 'gemini-api-key-placeholder-for-credential-isolation');

  // An AWF environment/routing probe only, not a real Gemini CLI model call.
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/offline-routing-probe');
    assert.equal(request.headers['x-goog-api-key'], process.env.GEMINI_API_KEY);
    response.writeHead(200);
    response.end('offline-proxy');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(10003, '127.0.0.1', resolve);
  });
  try {
    const response = await fetch(`${process.env.GOOGLE_GEMINI_BASE_URL}/offline-routing-probe`, {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    });
    assert.equal(await response.text(), 'offline-proxy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('UID1001: pinned Gemini secure-path acceptance/rejections, read-only policy, writable HOME, and offline AWF proxy routing passed');
}

const validator = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function loadValidator(transpiledSource) {
  const vm = require('node:vm');
  const module = { exports: {} };
  const unavailable = () => { throw new Error('Unexpected non-POSIX validator dependency'); };
  vm.runInNewContext(transpiledSource, {
    module, exports: module.exports, process, Buffer,
    require: (name) => {
      if (name === 'mnemonist') return { LRUCache: unavailable };
      if (name === './shell-utils.js') return { spawnAsync: unavailable };
      if (name === './paths.js') return { stripExtendedLengthPrefix: unavailable };
      if (name.startsWith('node:')) return require(name);
      throw new Error('Unexpected upstream dependency: ' + name);
    },
  });
  return module.exports.isFileAndDirectorySecureSync;
}

// Keep the upstream validator unmodified. Unused Windows/async dependencies
// fail loudly if invoked; the POSIX fs/stat/realpath operations are all real.
const verifierCode = `
(${prepareFixtures.toString()})();
process.setgroups([]);
process.setgid(1001);
process.setuid(1001);
const validate = (${loadValidator.toString()})(${JSON.stringify(validator)});
(${verifySettings.toString()})(${JSON.stringify(getGeminiSystemSettingsPath())}, validate)
  .catch(e => { console.error(e); process.exitCode = 1; });
`;
const composeLiteral = (text) => text.replace(/\$/g, () => '$$');

const initializer = buildGeminiSettingsService({ image });
const environment = buildGeminiCredentialEnv({
  config: { enableApiProxy: true, geminiApiKey: 'offline-test-key' },
  proxyIp: '127.0.0.1',
});
fs.writeFileSync(path.join(workDir, 'compose.json'), JSON.stringify({
  services: {
    [GEMINI_SETTINGS_SERVICE]: initializer,
    verifier: {
      image, user: '0:0', network_mode: 'none', read_only: true,
      cap_drop: ['ALL'], cap_add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID'],
      security_opt: ['no-new-privileges:true'],
      // Root prepares real ownership fixtures, then irreversibly drops to
      // UID/GID1001 with no effective capabilities before any validation.
      tmpfs: ['/fixtures:rw,noexec,nosuid,nodev,size=1m,mode=0755',
        '/home/runner:rw,noexec,nosuid,nodev,size=1m,mode=0755'],
      volumes: [`${GEMINI_SETTINGS_VOLUME}:/etc/awf/gemini-cli:ro`],
      environment: { ...environment, HOME: '/home/runner' },
      entrypoint: ['node', '-e', composeLiteral(verifierCode)],
      depends_on: {
        [GEMINI_SETTINGS_SERVICE]: { condition: 'service_completed_successfully' },
      },
    },
  },
  volumes: { [GEMINI_SETTINGS_VOLUME]: {} },
}, null, 2));

let completed = false;
try {
  // Never pull an image implicitly during this offline check.
  run('docker', ['image', 'inspect', image]);
  const result = compose(['run', '--rm', '--pull', 'never', 'verifier']);
  process.stdout.write(result.stdout);
  // Re-initialization is idempotent, and unsafe legacy entries fail closed.
  compose(['run', '--rm', '--no-deps', '--pull', 'never', GEMINI_SETTINGS_SERVICE]);
  for (const corrupt of [
    'ln -s /tmp/unused-target /settings/settings.json',
    'printf unchanged > /settings/sentinel; ln /settings/sentinel /settings/settings.json',
    'mkfifo /settings/settings.json',
    'mkdir /settings/settings.json',
  ]) {
    compose(['run', '--rm', '--no-deps', '--pull', 'never', '--entrypoint', '/bin/sh',
      GEMINI_SETTINGS_SERVICE, '-c', `rm -f /settings/settings.json; ${corrupt}`]);
    const rejected = compose(['run', '--rm', '--no-deps', '--pull', 'never', GEMINI_SETTINGS_SERVICE], true);
    assert.notEqual(rejected.status, 0, 'Unsafe staged entry was accepted');
    assert.match(rejected.stderr, /Refusing unsafe Gemini system settings file/);
    compose(['run', '--rm', '--no-deps', '--pull', 'never', '--entrypoint', '/bin/sh',
      GEMINI_SETTINGS_SERVICE, '-c',
    'set -eu; if [ -f /settings/sentinel ]; then test "$(cat /settings/sentinel)" = unchanged; fi; ' +
      'if [ -d /settings/settings.json ]; then rmdir /settings/settings.json; else rm -f /settings/settings.json; fi']);
  }
  console.log('Initializer: idempotence and symlink/hardlink/FIFO/directory rejection passed');
  completed = true;
} finally {
  try {
    if (!completed) {
      const logs = compose(['logs', '--no-color'], true);
      process.stderr.write(logs.stdout);
      process.stderr.write(logs.stderr);
    }
    compose(['down', '--volumes', '--remove-orphans']);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
