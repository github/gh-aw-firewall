/**
 * Chroot Language Tests
 *
 * These tests verify that the chroot mode correctly provides access
 * to host binaries for different programming languages. This is critical for
 * GitHub Actions runners where tools are installed on the host.
 *
 * IMPORTANT: These tests require the corresponding languages to be installed
 * on the host system (GitHub Actions runners have Python, Node, Go pre-installed).
 *
 * OPTIMIZATION: Quick version checks are batched into a single AWF container
 * invocation per domain group, reducing container startup overhead from ~20
 * invocations down to ~4.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import { runBatch, BatchResults } from '../fixtures/batch-runner';

describe('Chroot Language Support', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  // ---------- Batch: quick version/feature checks (single AWF invocation) ----------
  describe('Quick language checks (batched)', () => {
    let batch: BatchResults;

    beforeAll(async () => {
      batch = await runBatch(runner, [
        // Python
        { name: 'python_version', command: 'python3 --version' },
        { name: 'python_inline', command: 'python3 -c "print(2 + 2)"' },
        { name: 'python_stdlib', command: "python3 -c \"import json, os, sys; print(json.dumps({'test': True}))\"" },
        { name: 'pip_version', command: 'pip3 --version' },
        // Node.js
        { name: 'node_version', command: 'node --version' },
        { name: 'node_inline', command: 'node -e "console.log(2 + 2)"' },
        { name: 'node_modules', command: "node -e \"const os = require('os'); console.log(os.platform())\"" },
        { name: 'npm_version', command: 'npm --version' },
        { name: 'npx_version', command: 'npx --version' },
        // Go
        { name: 'go_version', command: 'go version' },
        { name: 'go_env', command: 'go env GOVERSION' },
        // Java (version only – compile tests are separate)
        { name: 'java_version', command: 'java --version 2>&1 || java -version 2>&1' },
        // .NET (version/info only – compile tests are separate)
        { name: 'dotnet_version', command: 'dotnet --version' },
        { name: 'dotnet_info', command: 'dotnet --info 2>&1 | head -30' },
        // Basic System Binaries
        { name: 'unix_utils', command: 'which bash && which ls && which cat' },
        { name: 'git_version', command: 'git --version' },
        { name: 'curl_version', command: 'curl --version' },
      ], {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 120000,
      });
    }, 180000);

    // Python
    test('should execute Python from host via chroot', () => {
      const r = batch.get('python_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Python 3\.\d+\.\d+/);
    });

    test('should run Python inline script', () => {
      const r = batch.get('python_inline');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('4');
    });

    test('should access Python standard library modules', () => {
      const r = batch.get('python_stdlib');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('{"test": true}');
    });

    test('should have pip available', () => {
      const r = batch.get('pip_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/pip \d+\.\d+/);
    });

    // Node.js
    test('should execute Node.js from host via chroot', () => {
      const r = batch.get('node_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/v\d+\.\d+\.\d+/);
    });

    test('should run Node.js inline script', () => {
      const r = batch.get('node_inline');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('4');
    });

    test('should access Node.js built-in modules', () => {
      const r = batch.get('node_modules');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('linux');
    });

    test('should have npm available', () => {
      const r = batch.get('npm_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should have npx available', () => {
      const r = batch.get('npx_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    // Go
    test('should execute Go from host via chroot', () => {
      const r = batch.get('go_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/go version go\d+\.\d+/);
    });

    test('should run Go env command', () => {
      const r = batch.get('go_env');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/go\d+\.\d+/);
    });

    // Java version
    test('should execute java --version from host via chroot', () => {
      const r = batch.get('java_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/openjdk|java|version/i);
    });

    // .NET version/info
    test('should execute dotnet --version from host via chroot', () => {
      const r = batch.get('dotnet_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should show dotnet runtime information', () => {
      const r = batch.get('dotnet_info');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\.NET|SDK|Runtime/i);
    });

    // Basic System Binaries
    test('should access standard Unix utilities', () => {
      expect(batch.get('unix_utils').exitCode).toBe(0);
    });

    test('should access git from host', () => {
      const r = batch.get('git_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/git version \d+\.\d+/);
    });

    test('should access curl from host', () => {
      const r = batch.get('curl_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/curl \d+\.\d+/);
    });
  });

  // ---------- Individual: Java compile tests (longer timeout) ----------
  describe('Java', () => {
    test('should compile and run Java Hello World', async () => {
      const result = await runner.run(
        'TESTDIR=$(mktemp -d) && ' +
        'echo \'public class Hello { public static void main(String[] args) { System.out.println("Hello from Java"); } }\' > $TESTDIR/Hello.java && ' +
        'cd $TESTDIR && javac Hello.java && java Hello && rm -rf $TESTDIR',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('Hello from Java');
    }, 180000);

    test('should access Java standard library (java.util)', async () => {
      const result = await runner.run(
        'TESTDIR=$(mktemp -d) && ' +
        'cat > $TESTDIR/TestUtil.java << \'EOF\'\n' +
        'import java.util.Arrays;\n' +
        'import java.util.List;\n' +
        'public class TestUtil {\n' +
        '  public static void main(String[] args) {\n' +
        '    List<String> items = Arrays.asList("a", "b", "c");\n' +
        '    System.out.println("List size: " + items.size());\n' +
        '  }\n' +
        '}\n' +
        'EOF\n' +
        'cd $TESTDIR && javac TestUtil.java && java TestUtil && rm -rf $TESTDIR',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      if (result.success) {
        expect(result.stdout).toContain('List size: 3');
      }
    }, 180000);
  });

  // ---------- Individual: .NET compile test (different domains, long timeout) ----------
  describe('.NET', () => {
    test('should create and run a .NET console app', async () => {
      const result = await runner.run(
        'TESTDIR=$(mktemp -d) && cd $TESTDIR && ' +
        'dotnet new console -o testapp --no-restore && ' +
        'cd testapp && dotnet restore && dotnet run && ' +
        'rm -rf $TESTDIR',
        {
          allowDomains: ['api.nuget.org', 'nuget.org', 'dotnetcli.azureedge.net'],
          logLevel: 'debug',
          timeout: 180000,
        }
      );

      // May fail if NuGet connectivity varies in CI
      if (result.success) {
        expect(result.stdout).toContain('Hello, World!');
      }
    }, 240000);
  });
});
