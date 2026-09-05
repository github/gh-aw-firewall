/**
 * Sudo `secure_path` Boundary Tests
 *
 * These tests exercise the real `sudo -E awf` entrypoint used by the
 * docker-sudo-iptables setup. sudoers' `secure_path` replaces the runner's
 * $GITHUB_PATH-augmented PATH with a fixed value before AWF ever observes
 * `process.env.PATH`, which previously let `/usr/bin/<tool>` shadow the
 * version selected by a setup-* action (e.g. ruby/setup-ruby).
 *
 * Rather than mocking the boundary, each test launches the built CLI through
 * `sudo -E env PATH=<secure_path> ...` so the stripped PATH is what the CLI
 * process actually starts with, then asserts on the PATH observed inside the
 * agent container.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import execa = require('execa');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanup } from '../fixtures/cleanup';

// The value most sudoers files ship as `Defaults secure_path`.
const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const AWF_PATH = path.resolve(__dirname, '../../dist/cli.js');
const STUB_NAME = 'awf-secure-path-probe';
const STUB_MARKER = 'AWF_SECURE_PATH_STUB_OK';

describe('sudo secure_path boundary', () => {
  let fixtureDir: string;
  let stubBinDir: string;
  let githubPathFile: string;

  beforeAll(async () => {
    await cleanup(false);

    // /tmp is bind-mounted read-write into the agent container, so a stub
    // placed here stands in for a hosted-toolcache bin directory.
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-secure-path-'));
    stubBinDir = path.join(fixtureDir, 'toolcache', 'bin');
    fs.mkdirSync(stubBinDir, { recursive: true });

    const stub = path.join(stubBinDir, STUB_NAME);
    fs.writeFileSync(stub, `#!/bin/sh\necho "${STUB_MARKER}"\n`);
    fs.chmodSync(stub, 0o755);
    // mkdtemp creates 0700; the agent runs as the mapped host user.
    fs.chmodSync(fixtureDir, 0o755);
    fs.chmodSync(path.dirname(stubBinDir), 0o755);
    fs.chmodSync(stubBinDir, 0o755);

    // Simulates a setup-* action having called core.addPath() before sudo ran.
    githubPathFile = path.join(fixtureDir, 'github_path');
    fs.writeFileSync(githubPathFile, `${stubBinDir}\n`);
    fs.chmodSync(githubPathFile, 0o644);
  });

  afterAll(async () => {
    await cleanup(false);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  /**
   * Run the CLI through sudo with a hard-coded `secure_path`-style PATH.
   *
   * `sudo -E env PATH=...` reproduces the sudoers behaviour deterministically:
   * whatever the host PATH was, the AWF process starts with only the fixed
   * secure_path entries.
   */
  async function runUnderSecurePath(
    command: string,
    githubPath: string | undefined,
  ): Promise<execa.ExecaReturnValue<string>> {
    // env options must precede NAME=VALUE assignments.
    const envArgs: string[] = githubPath ? [] : ['-u', 'GITHUB_PATH'];
    envArgs.push(`PATH=${SECURE_PATH}`);
    if (githubPath) {
      envArgs.push(`GITHUB_PATH=${githubPath}`);
    }

    return execa(
      'sudo',
      [
        '-E',
        'env',
        ...envArgs,
        // Absolute node path: the stripped PATH may not resolve `node`.
        process.execPath,
        AWF_PATH,
        '--legacy-security',
        '--allow-domains',
        'github.com',
        '--log-level',
        'debug',
        '--',
        command,
      ],
      {
        reject: false,
        all: true,
        timeout: 180000,
      },
    );
  }

  /**
   * The entrypoint echoes the command line before running it, so the literal
   * `AWF_PROBED_PATH=$PATH` text appears in stdout too. Keep only lines where
   * the marker was actually expanded to a PATH value.
   */
  function extractProbedPath(stdout: string): string {
    const values = stdout
      .split('\n')
      .map(line => /AWF_PROBED_PATH=(.*)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => match[1].trim())
      .filter(value => value.startsWith('/'));

    expect(values.length).toBeGreaterThan(0);
    return values[values.length - 1];
  }

  test('recovers $GITHUB_PATH entries ahead of /usr/bin despite secure_path', async () => {
    const result = await runUnderSecurePath(
      `bash -c 'echo AWF_PROBED_PATH=$PATH; ${STUB_NAME}'`,
      githubPathFile,
    );

    expect(result.exitCode).toBe(0);
    // The stub is only reachable if the $GITHUB_PATH entry survived the
    // sudo boundary and was merged into the agent's PATH.
    expect(result.stdout).toContain(STUB_MARKER);

    const entries = extractProbedPath(result.stdout).split(':');
    const stubIdx = entries.indexOf(stubBinDir);
    const usrBinIdx = entries.indexOf('/usr/bin');

    expect(stubIdx).toBeGreaterThanOrEqual(0);
    expect(usrBinIdx).toBeGreaterThanOrEqual(0);
    expect(stubIdx).toBeLessThan(usrBinIdx);
  }, 240000);

  test('does not add the toolcache dir when $GITHUB_PATH is unset', async () => {
    const result = await runUnderSecurePath(
      `bash -c 'echo AWF_PROBED_PATH=$PATH; command -v ${STUB_NAME} || echo AWF_STUB_NOT_FOUND'`,
      undefined,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AWF_STUB_NOT_FOUND');
    expect(extractProbedPath(result.stdout).split(':')).not.toContain(stubBinDir);
  }, 240000);
});
