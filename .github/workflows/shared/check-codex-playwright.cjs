#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

function printSandboxDiagnostics() {
  try {
    const helper = fs.statSync('/opt/google/chrome/chrome-sandbox');
    console.error(`System Chrome helper: uid=${helper.uid} gid=${helper.gid} mode=${(helper.mode & 0o7777).toString(8)}`);
  } catch {
    console.error('System Chrome sandbox helper is unavailable');
  }
  try {
    console.error(fs.readFileSync('/proc/self/status', 'utf8').split('\n')
      .filter(line => /^(NoNewPrivs|CapEff|CapBnd|Seccomp):/.test(line)).join('\n'));
  } catch {
    console.error('Process sandbox status is unavailable');
  }
  const mount = childProcess.spawnSync('findmnt', ['-n', '-o', 'OPTIONS', '-T', '/opt/google/chrome'], {
    encoding: 'utf8', timeout: 5000,
  });
  if (mount.status === 0) console.error(`/opt mount options: ${mount.stdout.trim()}`);
}

function runCheck(resultDir) {
  fs.mkdirSync(resultDir, { recursive: true });
  const resultFile = path.join(resultDir, 'result.json');
  fs.rmSync(resultFile, { force: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) throw new Error('AWF HTTPS_PROXY is required for the Playwright title check');

  const configFile = path.join(resultDir, 'cli.config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    browser: {
      browserName: 'chromium',
      isolated: true,
      launchOptions: {
        headless: true,
        // This smoke check uses AWF's outer isolation; its chroot/NNP prevents Chromium's nested sandbox.
        chromiumSandbox: false,
        proxy: { server: proxy, bypass: 'localhost,127.0.0.1' },
      },
    },
    outputDir: resultDir,
  }), { mode: 0o600 });

  const session = `codex-smoke-${crypto.randomBytes(8).toString('hex')}`;
  const cli = (...args) => {
    const result = childProcess.spawnSync('playwright-cli', [`-s=${session}`, ...args], {
      encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const sandboxError = /sandbox|No usable sandbox/i.test(`${result.stdout}\n${result.stderr}`);
      throw new Error(`playwright-cli ${args[0]} failed (exit=${result.status}, signal=${result.signal || 'none'}${sandboxError ? ', sandbox launch error' : ''})`);
    }
    return result.stdout.trim();
  };

  let title;
  try {
    try {
      cli('open', '--browser=chromium', `--config=${configFile}`, 'https://github.com');
      const output = cli('--raw', 'eval', '() => document.title');
      try {
        title = JSON.parse(output);
      } catch {
        throw new Error('Playwright did not return a JSON page title');
      }
      if (typeof title !== 'string' || !title.includes('GitHub')) {
        throw new Error('Expected the page title to contain GitHub');
      }
    } finally {
      cli('close');
    }
  } catch (error) {
    printSandboxDiagnostics();
    throw new Error(`Playwright title check failed: ${error.message}. Check the provisioned Chromium, CLI config, and AWF proxy; do not relax AWF privileges or mounts.`);
  }
  fs.writeFileSync(resultFile, JSON.stringify({ status: 'PASS', title }), { mode: 0o600 });
  console.log('Playwright GitHub title check: PASS');
}

if (require.main === module) {
  try {
    const [mode, resultDir] = process.argv.slice(2);
    if (!resultDir || mode !== 'run') {
      throw new Error('Usage: check-codex-playwright.cjs run <result-directory>');
    }
    runCheck(path.resolve(resultDir));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runCheck };
