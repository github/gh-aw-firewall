/**
 * filesystem.allowWrite integration tests
 *
 * These tests cover live container startup behavior that unit tests of volume
 * rewriting cannot catch, such as Docker/runc mountpoint creation order.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('filesystem.allowWrite', () => {
  let runner: AwfRunner;
  let testDir: string;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('starts the legacy Docker agent when /tmp is narrowed read-only', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-allowwrite-'));
    const writableDir = path.join(testDir, 'agent');
    fs.mkdirSync(writableDir, { recursive: true });
    const configPath = path.join(testDir, 'awf-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      network: {
        allowDomains: ['github.com'],
      },
      filesystem: {
        allowWrite: [writableDir],
      },
      container: {
        buildLocal: true,
      },
      logging: {
        logLevel: 'debug',
      },
      security: {
        legacySecurity: true,
      },
    }));

    const result = await runner.runWithSudo(
      `sh -c 'echo started > ${writableDir}/started.txt'`,
      {
        configFile: configPath,
        timeout: 120000,
      }
    );

    expect(result).toSucceed();
    expect(fs.readFileSync(path.join(writableDir, 'started.txt'), 'utf8')).toContain('started');
  }, 180000);

  test('keeps security helpers installed when /tmp is narrowed read-only', async () => {
    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-allowwrite-helpers-'));
    const writableDir = path.join(helperDir, 'agent');
    fs.mkdirSync(writableDir, { recursive: true });
    const configPath = path.join(helperDir, 'awf-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      network: { allowDomains: ['github.com'] },
      filesystem: { allowWrite: [writableDir] },
      container: { buildLocal: true },
      logging: { logLevel: 'debug' },
      security: { legacySecurity: true },
    }));

    // The helpers used to stage under /tmp/awf-lib. Once a write policy narrows
    // /tmp to read-only those copies failed silently, disabling one-shot token
    // protection. Prove the library is really present at its new location, not
    // merely that the container started.
    const result = await runner.runWithSudo(
      "sh -c 'ls -l /run/awf-lib/ > " + writableDir + "/helpers.txt 2>&1; " +
      "test -s /run/awf-lib/one-shot-token.so && echo ONE_SHOT_TOKEN_PRESENT >> " + writableDir + "/helpers.txt'",
      { configFile: configPath, timeout: 120000 },
    );

    expect(result).toSucceed();
    const helpers = fs.readFileSync(path.join(writableDir, 'helpers.txt'), 'utf8');
    expect(helpers).toContain('ONE_SHOT_TOKEN_PRESENT');

    fs.rmSync(helperDir, { recursive: true, force: true });
  }, 180000);

  test('leaves no AWF mount residue on the host after teardown', async () => {
    const residueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-allowwrite-residue-'));
    const writableDir = path.join(residueDir, 'agent');
    fs.mkdirSync(writableDir, { recursive: true });
    const configPath = path.join(residueDir, 'awf-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      network: { allowDomains: ['github.com'] },
      filesystem: { allowWrite: [writableDir] },
      container: { buildLocal: true },
      logging: { logLevel: 'debug' },
      security: { legacySecurity: true },
    }));

    const result = await runner.runWithSudo(
      `sh -c 'echo done > ${writableDir}/done.txt'`,
      { configFile: configPath, timeout: 120000 },
    );
    expect(result).toSucceed();

    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    expect(mounts).not.toContain(writableDir);
    expect(mounts).not.toContain('/run/awf-lib');

    fs.rmSync(residueDir, { recursive: true, force: true });
  }, 180000);
});
