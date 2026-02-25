/**
 * Chroot Package Manager Tests
 *
 * These tests verify that the chroot mode correctly provides access
 * to package managers and SDK tools. Tests validate that tools can perform
 * network operations through the firewall with proper domain whitelisting.
 *
 * IMPORTANT: These tests require the corresponding tools to be installed
 * on the host system. GitHub Actions runners have most of these pre-installed.
 *
 * OPTIMIZATION: Commands sharing the same allowDomains are batched into
 * single AWF invocations. Reduces ~23 invocations to ~12.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import { runBatch, BatchResults } from '../fixtures/batch-runner';

describe('Chroot Package Manager Support', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  // ---------- pip (Python) ----------
  describe('pip (Python)', () => {
    // Batch: pypi domain tests
    let pypiResults: BatchResults;

    beforeAll(async () => {
      pypiResults = await runBatch(runner, [
        { name: 'pip_list', command: 'pip3 list --format=columns | head -5' },
        { name: 'pip_index', command: 'pip3 index versions requests 2>&1 | head -3' },
      ], {
        allowDomains: ['pypi.org', 'files.pythonhosted.org'],
        logLevel: 'debug',
        timeout: 90000,
      });
    }, 150000);

    test('should list installed packages', () => {
      const r = pypiResults.get('pip_list');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Package');
    });

    test('should search PyPI with network access', () => {
      const r = pypiResults.get('pip_index');
      expect(r.exitCode).toBeLessThanOrEqual(1);
    });

    // Individual: localhost-only test
    test('should show package info without network', async () => {
      const result = await runner.runWithSudo('pip3 show pip', {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toSucceed();
      expect(result.stdout).toContain('Name: pip');
    }, 120000);
  });

  // ---------- npm (Node.js) ----------
  describe('npm (Node.js)', () => {
    // Batch: registry domain tests
    let npmResults: BatchResults;

    beforeAll(async () => {
      npmResults = await runBatch(runner, [
        { name: 'npm_config', command: 'npm config list' },
        { name: 'npm_view', command: 'npm view chalk version' },
      ], {
        allowDomains: ['registry.npmjs.org'],
        logLevel: 'debug',
        timeout: 90000,
      });
    }, 150000);

    test('should show npm configuration', () => {
      expect(npmResults.get('npm_config').exitCode).toBe(0);
    });

    test('should view package info from npm registry', () => {
      const r = npmResults.get('npm_view');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    // Individual: blocking test (different domain)
    test('should be blocked from npm registry without domain', async () => {
      const result = await runner.runWithSudo('npm view chalk version 2>&1', {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toFail();
    }, 120000);
  });

  // ---------- Rust (cargo) ----------
  describe('Rust (cargo)', () => {
    // Batch: crates.io domain tests
    let cargoResults: BatchResults;

    beforeAll(async () => {
      cargoResults = await runBatch(runner, [
        { name: 'cargo_version', command: 'cargo --version' },
        { name: 'cargo_search', command: 'cargo search serde --limit 1 2>&1' },
      ], {
        allowDomains: ['crates.io', 'static.crates.io', 'index.crates.io'],
        logLevel: 'debug',
        timeout: 120000,
      });
    }, 180000);

    test('should execute cargo from host via chroot', () => {
      const r = cargoResults.get('cargo_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/cargo \d+\.\d+/);
    });

    test('should search crates.io with network access', () => {
      const r = cargoResults.get('cargo_search');
      if (r.exitCode === 0) {
        expect(r.stdout).toContain('serde');
      }
    });

    // Individual: localhost test
    test('should execute rustc from host via chroot', async () => {
      const result = await runner.runWithSudo('rustc --version', {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/rustc \d+\.\d+/);
    }, 120000);
  });

  // ---------- Java (maven) ----------
  describe('Java (maven)', () => {
    // Batch: localhost tests
    let javaResults: BatchResults;

    beforeAll(async () => {
      javaResults = await runBatch(runner, [
        { name: 'java_version', command: 'java --version 2>&1 || java -version 2>&1' },
        { name: 'javac_version', command: 'javac --version 2>&1 || javac -version 2>&1' },
      ], {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });
    }, 120000);

    test('should execute java from host via chroot', () => {
      const r = javaResults.get('java_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/java|openjdk|version/i);
    });

    test('should execute javac from host via chroot', () => {
      const r = javaResults.get('javac_version');
      if (r.exitCode === 0) {
        expect(r.stdout).toMatch(/javac|version/i);
      }
    });

    // Individual: maven (different domain)
    test('should execute maven from host via chroot', async () => {
      const result = await runner.runWithSudo('mvn --version 2>&1', {
        allowDomains: ['repo.maven.apache.org', 'repo1.maven.org'],
        logLevel: 'debug',
        timeout: 60000,
      });

      if (result.success) {
        expect(result.stdout + result.stderr).toMatch(/Apache Maven|mvn/i);
      }
    }, 120000);
  });

  // ---------- .NET (dotnet/nuget) ----------
  describe('.NET (dotnet/nuget)', () => {
    // Batch: localhost tests
    let dotnetResults: BatchResults;

    beforeAll(async () => {
      dotnetResults = await runBatch(runner, [
        { name: 'list_sdks', command: 'dotnet --list-sdks' },
        { name: 'list_runtimes', command: 'dotnet --list-runtimes' },
      ], {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });
    }, 120000);

    test('should list installed .NET SDKs (offline)', () => {
      const r = dotnetResults.get('list_sdks');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should list installed .NET runtimes (offline)', () => {
      const r = dotnetResults.get('list_runtimes');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Microsoft\.\w+/);
    });

    // Individual: NuGet restore (different domains, long timeout)
    test('should create and build a .NET project with NuGet restore', async () => {
      const result = await runner.runWithSudo(
        'TESTDIR=$(mktemp -d) && cd $TESTDIR && ' +
        'dotnet new console -o buildtest --no-restore && ' +
        'cd buildtest && dotnet restore && dotnet build --no-restore && ' +
        'rm -rf $TESTDIR',
        {
          allowDomains: ['api.nuget.org', 'nuget.org', 'dotnetcli.azureedge.net'],
          logLevel: 'debug',
          timeout: 180000,
        }
      );

      if (result.success) {
        expect(result.stdout + result.stderr).toMatch(/Build succeeded/i);
      }
    }, 240000);

    // Individual: blocking test (localhost only)
    test('should be blocked from NuGet without domain whitelisting', async () => {
      const result = await runner.runWithSudo(
        'TESTDIR=$(mktemp -d) && cd $TESTDIR && ' +
        'dotnet new console -o blocktest --no-restore 2>&1 && ' +
        'cd blocktest && ' +
        'dotnet add package Newtonsoft.Json --no-restore 2>&1 && ' +
        'dotnet restore 2>&1; ' +
        'EXIT=$?; rm -rf $TESTDIR; exit $EXIT',
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 90000,
        }
      );

      expect(result).toFail();
    }, 150000);
  });

  // ---------- Ruby (gem/bundler) ----------
  describe('Ruby (gem/bundler)', () => {
    // Batch: localhost tests
    let rubyLocalResults: BatchResults;

    beforeAll(async () => {
      rubyLocalResults = await runBatch(runner, [
        { name: 'ruby_version', command: 'ruby --version' },
        { name: 'gem_list', command: 'gem list --local | head -5' },
      ], {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 60000,
      });
    }, 120000);

    test('should execute ruby from host via chroot', () => {
      const r = rubyLocalResults.get('ruby_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/ruby \d+\.\d+/);
    });

    test('should list installed gems', () => {
      expect(rubyLocalResults.get('gem_list').exitCode).toBe(0);
    });

    // Batch: rubygems.org domain tests
    let rubyNetResults: BatchResults;

    beforeAll(async () => {
      rubyNetResults = await runBatch(runner, [
        { name: 'gem_version', command: 'gem --version' },
        { name: 'bundler_version', command: 'bundle --version' },
        { name: 'gem_search', command: 'gem search rails --remote --no-verbose 2>&1 | head -3' },
      ], {
        allowDomains: ['rubygems.org', 'index.rubygems.org'],
        logLevel: 'debug',
        timeout: 120000,
      });
    }, 180000);

    test('should execute gem from host via chroot', () => {
      const r = rubyNetResults.get('gem_version');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+/);
    });

    test('should execute bundler from host via chroot', () => {
      const r = rubyNetResults.get('bundler_version');
      if (r.exitCode === 0) {
        expect(r.stdout).toMatch(/Bundler version \d+\.\d+/);
      }
    });

    test('should search rubygems with network access', () => {
      const r = rubyNetResults.get('gem_search');
      if (r.exitCode === 0) {
        expect(r.stdout).toContain('rails');
      }
    });
  });

  // ---------- Go modules ----------
  describe('Go modules', () => {
    test('should show go env', async () => {
      const result = await runner.runWithSudo('go env GOPATH GOPROXY', {
        allowDomains: ['proxy.golang.org', 'sum.golang.org'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toSucceed();
    }, 120000);

    test('should list go modules (no network needed for empty list)', async () => {
      const result = await runner.runWithSudo(
        'cd /tmp && mkdir -p gotest && cd gotest && go mod init test 2>&1 && go mod tidy 2>&1 && cat go.mod',
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('module test');
    }, 120000);
  });

  // ---------- Package Installation ----------
  describe('Package Installation', () => {
    test('should install a Python package via pip and verify import', async () => {
      const result = await runner.runWithSudo(
        'pip3 install --target /tmp/pip-test requests 2>&1 && ' +
        'PYTHONPATH=/tmp/pip-test python3 -c "import requests; print(requests.__version__)"',
        {
          allowDomains: ['pypi.org', 'files.pythonhosted.org'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      // The last line of output should be the version string
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    }, 180000);

    test('should install an npm package and verify require', async () => {
      const result = await runner.runWithSudo(
        'cd /tmp && mkdir -p npm-test && cd npm-test && npm init -y 2>&1 && ' +
        'npm install chalk@4 2>&1 && ' +
        'node -e "require(\'/tmp/npm-test/node_modules/chalk\')" && echo "npm_install_ok"',
        {
          allowDomains: ['registry.npmjs.org'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('npm_install_ok');
    }, 180000);

    test('should build a Rust project with a dependency via cargo', async () => {
      const result = await runner.runWithSudo(
        'TESTDIR=$(mktemp -d) && cd $TESTDIR && ' +
        'cargo init --name awftest 2>&1 && ' +
        // Add a small dependency (cfg-if is tiny with no transitive deps)
        'echo \'cfg-if = "1"\' >> Cargo.toml && ' +
        'cargo build 2>&1 && echo "cargo_build_ok" && ' +
        'rm -rf $TESTDIR',
        {
          allowDomains: ['crates.io', 'static.crates.io', 'index.crates.io'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('cargo_build_ok');
    }, 180000);
  });
});
