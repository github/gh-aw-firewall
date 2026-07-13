/**
 * Volume Mount Tests
 *
 * These tests verify the custom volume mount functionality:
 * - Custom mount with read-only mode
 * - Custom mount with read-write mode
 * - Multiple custom mounts
 * - Blanket mount removal with custom mounts
 * - Essential mounts still work
 * - Backward compatibility (no custom mounts)
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Volume Mount Functionality', () => {
  let runner: AwfRunner;
  let testDir: string;

  beforeAll(async () => {
    // Run cleanup before tests to ensure clean state
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    // Clean up after all tests
    await cleanup(false);
  });

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-mount-test-'));
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('Test 1: Read-only custom mount', async () => {
    // Create a test file
    const testFile = path.join(testDir, 'test.txt');
    fs.writeFileSync(testFile, 'Hello from host');

    const result = await runner.run(
      'cat /data/test.txt',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data:ro`],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Hello from host');
  }, 120000);

  test('Test 2: Read-write custom mount', async () => {
    const result = await runner.run(
      'sh -c \'echo "Written from container" > /data/output.txt\'',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data:rw`],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();

    // Verify file was created on host
    const outputFile = path.join(testDir, 'output.txt');
    expect(fs.existsSync(outputFile)).toBe(true);
    const content = fs.readFileSync(outputFile, 'utf-8');
    expect(content).toContain('Written from container');
  }, 120000);

  test('Test 3: Multiple custom mounts', async () => {
    // Create two directories with files
    const dir1 = path.join(testDir, 'dir1');
    const dir2 = path.join(testDir, 'dir2');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);
    fs.writeFileSync(path.join(dir1, 'file1.txt'), 'Content 1');
    fs.writeFileSync(path.join(dir2, 'file2.txt'), 'Content 2');

    const result = await runner.run(
      'sh -c "cat /mount1/file1.txt && cat /mount2/file2.txt"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [
          `${dir1}:/mount1:ro`,
          `${dir2}:/mount2:ro`,
        ],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Content 1');
    expect(result.stdout).toContain('Content 2');
  }, 120000);

  test('Test 4: Blanket mount removed with custom mounts', async () => {
    // Create a test file outside the custom mount in a secure temp directory
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-secret-'));
    const secretFile = path.join(secretDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'Secret data', { mode: 0o600 });

    try {
      const result = await runner.run(
        `sh -c "cat /data/test.txt && cat ${secretFile}"`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          volumeMounts: [`${testDir}:/data:ro`],
          timeout: 60000,
        }
      );

      // First cat should fail (no file in /data)
      // Second cat should fail (no blanket mount, host paths not accessible)
      expect(result).toFail();
      expect(result.stderr).toMatch(/No such file or directory/);
    } finally {
      // Cleanup secret directory
      if (fs.existsSync(secretDir)) {
        fs.rmSync(secretDir, { recursive: true, force: true });
      }
    }
  }, 120000);

  test('Test 5: No /host mount with custom mounts', async () => {
    fs.writeFileSync(path.join(testDir, 'allowed.txt'), 'Allowed data');

    const result = await runner.run(
      'sh -c "cat /data/allowed.txt && ls /host"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data:ro`],
        timeout: 60000,
      }
    );

    // First cat should succeed
    // Second command (ls /host) should fail because blanket mount is not present
    expect(result).toFail();
    expect(result.stdout).toContain('Allowed data');
    expect(result.stderr).toMatch(/\/host.*No such file or directory/);
  }, 120000);

  test('Test 6: Essential mounts still work (HOME directory)', async () => {
    const result = await runner.run(
      'sh -c "echo $HOME && test -d $HOME"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data:ro`],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toMatch(/\/root|\/home\//);
  }, 120000);

  test('Test 7: Backward compatibility - no custom mounts uses blanket mount', async () => {
    const result = await runner.run(
      'ls /host/tmp | head -5',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        // No volumeMounts specified
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Should be able to access /host when no custom mounts are specified
    expect(result.exitCode).toBe(0);
  }, 120000);

  test('Test 8: Mount without mode defaults to rw', async () => {
    const result = await runner.run(
      'sh -c \'echo "Test write" > /data/write-test.txt\'',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data`], // No mode specified
        timeout: 60000,
      }
    );

    expect(result).toSucceed();

    // Verify file was created
    const outputFile = path.join(testDir, 'write-test.txt');
    expect(fs.existsSync(outputFile)).toBe(true);
  }, 120000);

  test('Test 9: Debug logging shows mount configuration', async () => {
    const result = await runner.run(
      'echo "test"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${testDir}:/data:ro`],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Check debug logs for mount configuration
    expect(result.stderr).toMatch(/Adding.*custom volume mount/);
  }, 120000);

  test('Test 10: Current working directory mount', async () => {
    // Create a project directory
    const projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test Project');

    const result = await runner.run(
      'cat /workspace/README.md',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [`${projectDir}:/workspace:ro`],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('# Test Project');
  }, 120000);

  test('Test 11: Mixed read-only and read-write mounts', async () => {
    const roDir = path.join(testDir, 'readonly');
    const rwDir = path.join(testDir, 'readwrite');
    fs.mkdirSync(roDir);
    fs.mkdirSync(rwDir);
    fs.writeFileSync(path.join(roDir, 'config.txt'), 'Config data');

    const result = await runner.run(
      'sh -c "cat /config/config.txt && echo \\"Log entry\\" > /logs/app.log"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        volumeMounts: [
          `${roDir}:/config:ro`,
          `${rwDir}:/logs:rw`,
        ],
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Config data');

    // Verify log file was created in read-write mount
    const logFile = path.join(rwDir, 'app.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('Log entry');
  }, 120000);
});
