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
});
