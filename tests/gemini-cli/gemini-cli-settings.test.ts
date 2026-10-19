/**
 * Requires Linux, passwordless sudo, and the smoke workflow's pinned Gemini install:
 * npm install --ignore-scripts --prefix /tmp/awf-gemini-cli-test @google/gemini-cli@0.64.0
 * GEMINI_CLI_TEST_PACKAGE=/tmp/awf-gemini-cli-test/node_modules/@google/gemini-cli \
 *   npx jest --config jest.config.js --roots tests/gemini-cli --runInBand \
 *   --runTestsByPath tests/gemini-cli/gemini-cli-settings.test.ts
 *
 * This deliberately has explicit discovery: missing prerequisites must fail,
 * rather than silently skipping the actual CLI/UID-1001 regression check.
 */
import * as assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGeminiCredentialEnv } from '../../src/services/credentials/gemini-credential-env';
import {
  buildGeminiSystemSettingsContent,
  GEMINI_CLI_SYSTEM_SETTINGS_PATH,
} from '../../src/services/credentials/gemini-cli-settings';
import type { WrapperConfig } from '../../src/types';

describe('Gemini CLI 0.64.0 settings and authentication as UID 1001', () => {
  it('rejects runner-owned system settings, but authenticates through the proxy with AWF settings', async () => {
    assert.equal(process.platform, 'linux', 'This integration harness requires Linux');
    const packageDir = process.env.GEMINI_CLI_TEST_PACKAGE;
    assert.ok(packageDir, 'Set GEMINI_CLI_TEST_PACKAGE to an installed @google/gemini-cli@0.64.0 package');
    const geminiDir = path.resolve(packageDir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(geminiDir, 'package.json'), 'utf8')).version, '0.64.0');
    const entry = path.join(geminiDir, 'bundle/gemini.js');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-harness-'));
    const home = path.join(workspace, 'home');
    const insecureSettings = path.join(home, '.awf', 'settings.json');
    assert.ok(GEMINI_CLI_SYSTEM_SETTINGS_PATH.startsWith('/etc/'));
    const systemRelativePath = GEMINI_CLI_SYSTEM_SETTINGS_PATH.slice('/etc/'.length);
    const requests: Array<{ url: string; key: string | string[] | undefined }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url || '', key: request.headers['x-goog-api-key'] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'AWF_GEMINI_OK' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n\n`);
    });
    // Refuse unsafe ancestors and never overwrite an existing system configuration.
    const provision = `
      const fs = require('node:fs'), path = require('node:path');
      const file = process.argv[1];
      if (process.argv[2] === 'create') {
        const missing = [], ancestors = [];
        for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
          ancestors.unshift(dir);
          if (dir === path.dirname(dir)) break;
        }
        for (const dir of ancestors) {
          let stat;
          try { stat = fs.lstatSync(dir); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const relativeDir = path.relative(process.cwd(), dir);
            fs.mkdirSync(relativeDir, { mode: 0o755 });
            missing.unshift(relativeDir);
            stat = fs.lstatSync(dir);
          }
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) {
            throw new Error('Refusing unsafe settings ancestor: ' + dir);
          }
        }
        try { fs.lstatSync(file); throw new Error('Refusing to overwrite ' + file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.writeFileSync(file, process.argv[3], { flag: 'wx', mode: 0o644 });
        console.log(JSON.stringify(missing));
      } else {
        fs.unlinkSync(file);
        for (const dir of JSON.parse(process.argv[3])) fs.rmdirSync(dir);
      }
    `;
    let provisioned = false;
    let createdDirectories = '[]';
    try {
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.mkdirSync(path.dirname(insecureSettings), { recursive: true });
      fs.writeFileSync(insecureSettings, buildGeminiSystemSettingsContent());
      // A conflicting user choice also verifies system-scope merge precedence.
      fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'gateway' } },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        advanced: { autoConfigureMemory: false },
      }));
      execFileSync('sudo', ['-n', 'chown', '-R', '1001:1001', workspace]);
      createdDirectories = execFileSync('sudo', ['-n', process.execPath, '-e', provision, systemRelativePath, 'create',
        buildGeminiSystemSettingsContent()], { cwd: '/etc', encoding: 'utf8' }).trim();
      provisioned = true;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const credentialEnv = buildGeminiCredentialEnv({
        config: { enableApiProxy: true, geminiApiKey: 'real-key-must-not-reach-cli' } as WrapperConfig,
        proxyIp: '127.0.0.1',
      });
      expect(credentialEnv.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      expect(Object.values(credentialEnv)).not.toContain('real-key-must-not-reach-cli');
      const run = (settings: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', `
          const assert = require('node:assert/strict'), net = require('node:net');
          assert.equal(process.getuid(), 1001);
          console.error('AWF_TEST_UID=1001');
          const connect = net.Socket.prototype.connect;
          net.Socket.prototype.connect = function(...args) {
            const options = Array.isArray(args[0]) ? args[0][0] : args[0];
            if (options.host !== '127.0.0.1' || Number(options.port) !== Number(process.env.AWF_TEST_PROXY_PORT)) {
              console.error('AWF_TEST_FORBIDDEN_NETWORK');
              throw new Error('Only the local fake proxy is allowed');
            }
            return connect.apply(this, args);
          };
          import(require('node:url').pathToFileURL(process.argv[1]).href);
        `, entry, '--prompt', 'Reply with the supplied proxy response.', '--model', 'gemini-2.5-flash',
        '--output-format', 'json'], {
          cwd: home,
          uid: 1001,
          gid: 1001,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: workspace,
            ...credentialEnv,
            GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
            GEMINI_API_BASE_URL: `http://127.0.0.1:${address.port}`,
            GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings,
            GEMINI_CLI_NO_RELAUNCH: '1',
            GEMINI_CLI_TRUST_WORKSPACE: 'true',
            AWF_TEST_PROXY_PORT: String(address.port),
            GEMINI_TELEMETRY_ENABLED: 'false',
            NO_COLOR: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Gemini timed out\n${stdout}\n${stderr}`));
        }, 30000);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });

      const rejected = await run(insecureSettings);
      expect(rejected.stderr).toContain('AWF_TEST_UID=1001');
      expect(rejected.code).toBe(41);
      expect(rejected.stderr).toContain('Invalid auth method selected.');
      expect(rejected.stderr).not.toContain('AWF_TEST_FORBIDDEN_NETWORK');
      expect(requests).toEqual([]);

      const accepted = await run(GEMINI_CLI_SYSTEM_SETTINGS_PATH);
      expect(accepted.stderr).toContain('AWF_TEST_UID=1001');
      expect(accepted.stderr).not.toContain('AWF_TEST_FORBIDDEN_NETWORK');
      assert.equal(accepted.code, 0, JSON.stringify(accepted));
      expect(accepted.stdout).toContain('AWF_GEMINI_OK');
      expect(requests.some(({ url }) => url.includes(':streamGenerateContent'))).toBe(true);
      expect(requests.every(({ key }) => key === credentialEnv.GEMINI_API_KEY)).toBe(true);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (provisioned) execFileSync('sudo', ['-n', process.execPath, '-e', provision, systemRelativePath, 'remove',
        createdDirectories], { cwd: '/etc' });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 90000);
});
