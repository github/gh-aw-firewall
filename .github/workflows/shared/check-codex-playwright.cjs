#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
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
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
  if (mount.status === 0) console.error(`/opt mount options: ${mount.stdout.trim()}`);
}

function escapedDiagnostic(value) {
  const text = String(value ?? '');
  return JSON.stringify(text.slice(0, 512) + (text.length > 512 ? '…' : ''))
    .replace(/[\x7f-\x9f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/%/g, '\\u0025').replace(/:/g, '\\u003a');
}

function runCheck() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) throw new Error('AWF HTTPS_PROXY is required for the Playwright title check');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-playwright-'));

  try {
    checkTitle(scratch, proxy);
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      console.error(`Playwright scratch cleanup failed: ${escapedDiagnostic(error.message)}`);
    }
  }
  console.log('Playwright GitHub title check: PASS');
}

function checkTitle(scratch, proxy) {
  const configFile = path.join(scratch, 'cli.config.json');
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
    outputDir: scratch,
  }), { mode: 0o600 });

  const session = `codex-smoke-${crypto.randomBytes(8).toString('hex')}`;
  const cli = (command, flags, ...args) => {
    const result = childProcess.spawnSync('playwright-cli', [`-s=${session}`, ...flags, command, ...args], {
      encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || /^### Error\b/m.test(result.stdout ?? '')) {
      const details = [
        ['spawn error', result.error?.message],
        ['stderr', result.stderr],
        ['stdout', result.stdout],
      ].filter(([, value]) => value).map(([label, value]) => `${label}=${escapedDiagnostic(value)}`);
      throw new Error(`playwright-cli ${command} failed (exit=${result.status}, signal=${result.signal || 'none'}) ${details.join(' ')}`.trim());
    }
    return result.stdout.trim();
  };

  let primaryError;
  try {
    cli('open', [], '--browser=chromium', `--config=${configFile}`, 'https://github.com');
    const output = cli('eval', ['--raw'], '() => document.title');
    let title;
    try {
      title = JSON.parse(output);
    } catch {
      throw new Error(`Playwright did not return a JSON page title: ${escapedDiagnostic(output)}`);
    }
    if (typeof title !== 'string' || !title.includes('GitHub')) {
      throw new Error('Expected the page title to contain GitHub');
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    const output = cli('close', ['--json']);
    let closed;
    try {
      closed = JSON.parse(output);
    } catch {
      throw new Error(`playwright-cli close returned invalid JSON: ${escapedDiagnostic(output)}`);
    }
    if (closed?.session !== session || closed.status !== 'closed') {
      throw new Error(`playwright-cli close did not confirm session closure: ${escapedDiagnostic(output)}`);
    }
  } catch (error) {
    if (primaryError) console.error(`Playwright session cleanup also failed: ${error.message}`);
    else primaryError = error;
  }
  if (primaryError) {
    printSandboxDiagnostics();
    throw new Error(`Playwright title check failed: ${primaryError.message}. Check the provisioned Chromium, CLI config, and AWF proxy; do not relax AWF privileges or mounts.`, { cause: primaryError });
  }
}

if (require.main === module) {
  try {
    runCheck();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runCheck };
