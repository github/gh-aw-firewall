# Test Infrastructure Analysis

This document provides a comprehensive analysis of the test fixtures, runners, matchers, and infrastructure used by the gh-aw-firewall integration test suite.

---

## Table of Contents

- [Overview](#overview)
- [Test Runner Architecture](#test-runner-architecture)
- [Abstractions Provided](#abstractions-provided)
- [Batch Runner Pattern](#batch-runner-pattern)
- [Cleanup Strategy](#cleanup-strategy)
- [CI Workflow Post-Processing](#ci-workflow-post-processing)
- [Limitations](#limitations)
- [Improvement Opportunities](#improvement-opportunities)

---

## Overview

The test infrastructure lives in two primary locations:

| Path | Purpose |
|------|---------|
| `tests/fixtures/` | Reusable test helpers: runners, matchers, cleanup, log parsing |
| `tests/setup/` | Jest configuration and setup files |
| `scripts/ci/` | CI-specific cleanup and workflow post-processing scripts |

The suite contains **26 integration test files** across `tests/integration/`, all executed serially via Jest with a 120-second per-test timeout.

### Key Files

| File | Lines | Role |
|------|-------|------|
| `tests/fixtures/awf-runner.ts` | 331 | Core test runner — wraps AWF CLI invocations |
| `tests/fixtures/batch-runner.ts` | 118 | Batches multiple commands into a single container |
| `tests/fixtures/assertions.ts` | 179 | Custom Jest matchers (`toSucceed`, `toFail`, etc.) |
| `tests/fixtures/docker-helper.ts` | 297 | Low-level Docker operations helper |
| `tests/fixtures/cleanup.ts` | 209 | TypeScript port of `cleanup.sh` |
| `tests/fixtures/log-parser.ts` | 224 | Squid and iptables log parsing |
| `tests/setup/jest.integration.config.js` | 24 | Jest config for integration tests |
| `tests/setup/jest.setup.ts` | 9 | Registers custom matchers globally |
| `scripts/ci/cleanup.sh` | 56 | Bash cleanup script for CI |
| `scripts/ci/postprocess-smoke-workflows.ts` | 150 | Post-processes compiled workflow YAML for CI |

---

## Test Runner Architecture

### AwfRunner (`tests/fixtures/awf-runner.ts`)

The `AwfRunner` class is the central abstraction for integration tests. It wraps the AWF CLI binary and provides two execution modes:

#### `run(command, options)` — Direct execution
- Runs `node dist/cli.js <args> -- <command>` directly
- Suitable for tests that don't require iptables (no sudo)
- Rarely used in practice (most tests need sudo for iptables)

#### `runWithSudo(command, options)` — Privileged execution
- Runs `sudo -E --preserve-env=PATH,HOME,... node dist/cli.js <args> -- <command>`
- Preserves critical environment variables (`PATH`, `HOME`, `GOROOT`, `CARGO_HOME`, `JAVA_HOME`, `DOTNET_ROOT`)
- Required for real firewall operation (iptables NAT rules)
- Used by ~95% of integration tests

#### AwfOptions Interface

All CLI flags are exposed as typed options:

```typescript
interface AwfOptions {
  allowDomains?: string[];
  keepContainers?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  buildLocal?: boolean;
  imageRegistry?: string;
  imageTag?: string;
  timeout?: number;              // Default: 120000ms
  env?: Record<string, string>;
  volumeMounts?: string[];
  containerWorkDir?: string;
  tty?: boolean;
  dnsServers?: string[];
  allowHostPorts?: string;
  enableApiProxy?: boolean;
}
```

#### AwfResult Interface

Every invocation returns a structured result:

```typescript
interface AwfResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;      // exitCode === 0
  timedOut: boolean;
  workDir?: string;      // Extracted from stderr: /tmp/awf-<timestamp>
}
```

The `workDir` is particularly important — it's extracted from AWF's stderr logs and used by log-based assertions (`toAllowDomain`, `toBlockDomain`) to locate Squid access logs.

#### Typical Test Pattern

```typescript
describe('Feature X', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);       // Pre-test cleanup
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);       // Post-test cleanup
  });

  test('should do something', async () => {
    const result = await runner.runWithSudo(
      'curl -f https://api.github.com/zen',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toSucceed();
  }, 120000);  // Jest timeout (must be >= AWF timeout)
});
```

### Jest Configuration (`tests/setup/jest.integration.config.js`)

Key settings:

| Setting | Value | Rationale |
|---------|-------|-----------|
| `testTimeout` | 120000 (2 min) | Firewall tests involve Docker container lifecycle |
| `maxWorkers` | 1 | Serial execution — avoids Docker network/container conflicts |
| `verbose` | true | Full test output for CI debugging |
| `preset` | `ts-jest` | TypeScript compilation |
| `setupFilesAfterEnv` | `jest.setup.ts` | Registers custom matchers before tests run |

Tests are discovered from `tests/integration/**/*.test.ts`.

---

## Abstractions Provided

### Custom Jest Matchers (`tests/fixtures/assertions.ts`)

Six custom matchers extend Jest's `expect()`, registered globally via `jest.setup.ts`:

| Matcher | Asserts | Input |
|---------|---------|-------|
| `toSucceed()` | `result.success === true` (exit code 0) | `AwfResult` |
| `toFail()` | `result.success === false` (non-zero exit) | `AwfResult` |
| `toExitWithCode(code)` | `result.exitCode === code` | `AwfResult` |
| `toTimeout()` | `result.timedOut === true` | `AwfResult` |
| `toAllowDomain(domain)` | Domain appears as `TCP_TUNNEL` in Squid logs | `AwfResult` |
| `toBlockDomain(domain)` | Domain appears as `TCP_DENIED` in Squid logs | `AwfResult` |

**Type declarations** are in `tests/jest-custom-matchers.d.ts`, included in test files via:
```typescript
/// <reference path="../jest-custom-matchers.d.ts" />
```

#### Log-Based Matchers

`toAllowDomain` and `toBlockDomain` are more sophisticated — they:
1. Extract `workDir` from the `AwfResult`
2. Read `${workDir}/squid-logs/access.log` synchronously (Jest matchers must be sync)
3. Parse the Squid log using `LogParser`
4. Check for `TCP_TUNNEL` (allowed) or `TCP_DENIED` (blocked) entries for the domain

These require `keepContainers: true` to preserve the work directory.

### Docker Helper (`tests/fixtures/docker-helper.ts`)

A general-purpose Docker operations wrapper:

| Method | Purpose |
|--------|---------|
| `pullImage(image)` | Pull a Docker image |
| `run(options)` | Run a container with full option support |
| `stop(name)` | Stop a container |
| `rm(name, force?)` | Remove a container |
| `inspect(name)` | Get container state and network info |
| `logs(name, options?)` | Retrieve container logs |
| `exec(name, command)` | Execute command in running container |
| `networkExists(name)` | Check if a Docker network exists |
| `createNetwork(name, subnet?)` | Create a Docker network |
| `removeNetwork(name)` | Remove a Docker network |
| `listContainers(options?)` | List containers by filter |
| `wait(name)` | Wait for container exit and return exit code |
| `isRunning(name)` | Check if a container is currently running |

All methods use `execa` with `reject: false` to handle errors gracefully.

**Note:** This helper is available but less commonly used in practice — most tests go through `AwfRunner.runWithSudo()` which handles the full container lifecycle automatically.

### Log Parser (`tests/fixtures/log-parser.ts`)

Parses two log formats:

#### Squid Log Parser

Parses the `firewall_detailed` log format:
```
%ts.%03tu %>a:%>p %{Host}>h %<a:%<p %rv %rm %>Hs %Ss:%Sh %ru "%{User-Agent}>h"
```

Into typed `SquidLogEntry` objects with fields: `timestamp`, `clientIp`, `clientPort`, `host`, `destIp`, `destPort`, `protocol`, `method`, `statusCode`, `decision`, `hierarchy`, `url`, `userAgent`.

Filtering methods:
- `filterByDecision(entries, 'allowed' | 'blocked')` — Filter by `TCP_TUNNEL`/`TCP_DENIED`
- `filterByDomain(entries, domain)` — Filter by exact or subdomain match
- `getUniqueDomains(entries)` — Deduplicated domain list
- `wasAllowed(entries, domain)` / `wasBlocked(entries, domain)` — Boolean checks

#### iptables Log Parser

Parses kernel log entries prefixed with `[FW_BLOCKED_UDP]` or `[FW_BLOCKED_OTHER]` from `dmesg` output.

---

## Batch Runner Pattern

### Problem

Each `runner.runWithSudo()` call spawns a full Docker container lifecycle: config generation, Docker Compose up (Squid + Agent), iptables setup, command execution, teardown. This takes **15-25 seconds per invocation**.

The chroot language test suite originally had ~73 individual test invocations, each with this overhead.

### Solution: `batch-runner.ts`

The batch runner groups commands that share the same `AwfOptions` (particularly `allowDomains`) into a **single AWF container invocation**. This reduced the chroot suite from ~73 to ~27 container startups.

#### How It Works

1. **Script Generation** — Each command is wrapped in delimiters:
   ```bash
   echo "===BATCH_START:python_version==="
   (python3 --version) 2>&1
   _EC=$?
   echo ""
   echo "===BATCH_EXIT:python_version:$_EC==="
   ```

2. **Single Invocation** — The concatenated script runs as one `runWithSudo()` call.

3. **Result Parsing** — The combined stdout is parsed back into per-command results:
   ```typescript
   const batch = await runBatch(runner, [
     { name: 'python_version', command: 'python3 --version' },
     { name: 'node_version', command: 'node --version' },
   ], { allowDomains: ['github.com'] });

   expect(batch.get('python_version').exitCode).toBe(0);
   ```

#### Interface

```typescript
interface BatchCommand {
  name: string;    // Unique identifier for this command
  command: string; // Shell command to execute
}

interface BatchCommandResult {
  stdout: string;   // Captured output (stdout + stderr merged)
  exitCode: number; // Per-command exit code
}

interface BatchResults {
  get(name: string): BatchCommandResult;  // Throws if name not found
  overall: AwfResult;                      // Raw AWF result for the whole batch
}
```

#### Design Decisions

- Each command runs in a **subshell** `(cmd) 2>&1` so failures don't abort the batch
- **stdout and stderr are merged** via `2>&1` — individual stderr is not preserved
- Exit code is captured immediately into `_EC=$?` before `echo` resets `$?`
- Delimiter tokens (`===BATCH_START:`, `===BATCH_EXIT:`) chosen to be unlikely in real output
- If the batch is killed early, missing commands get `exitCode: -1`

#### Usage Pattern in Tests

The batch runner is used in `beforeAll` to run all commands once, then individual `test()` blocks assert against named results:

```typescript
describe('Quick checks (batched)', () => {
  let batch: BatchResults;

  beforeAll(async () => {
    batch = await runBatch(runner, [
      { name: 'python_version', command: 'python3 --version' },
      { name: 'go_version', command: 'go version' },
    ], { allowDomains: ['github.com'], timeout: 120000 });
  }, 180000);

  test('Python available', () => {
    expect(batch.get('python_version').exitCode).toBe(0);
  });

  test('Go available', () => {
    expect(batch.get('go_version').exitCode).toBe(0);
  });
});
```

This pattern is used extensively in `chroot-languages.test.ts` (17 batched commands) and `chroot-package-managers.test.ts`.

---

## Cleanup Strategy

The cleanup system uses a **defense-in-depth** approach across four stages, accounting for the fact that Docker container and network resources can leak when processes are killed mid-lifecycle.

### Stage 1: Pre-Test Cleanup (TypeScript)

**File:** `tests/fixtures/cleanup.ts`

The `Cleanup` class is a TypeScript port of the shell script, providing the same operations as programmable methods:

```typescript
class Cleanup {
  removeContainers()           // docker rm -f awf-squid awf-agent
  stopDockerComposeServices()  // docker compose down -v for all /tmp/awf-*/
  cleanupIptables()            // Remove FW_WRAPPER chain from DOCKER-USER
  removeNetwork()              // docker network rm awf-net
  pruneContainers()            // docker container prune -f
  pruneNetworks()              // docker network prune -f (fixes "Pool overlaps")
  removeWorkDirectories()      // rm -rf /tmp/awf-*
  cleanAll()                   // All of the above in sequence
}
```

Called in `beforeAll` and `afterAll` of every test `describe` block:
```typescript
beforeAll(async () => { await cleanup(false); });
afterAll(async () => { await cleanup(false); });
```

### Stage 2: Normal Exit (AWF Built-in)

AWF's own cleanup in `src/cli.ts`:
- `docker compose down -v` stops containers
- Deletes the work directory `/tmp/awf-<timestamp>`

### Stage 3: Signal/Error (AWF Built-in)

SIGINT/SIGTERM handlers in `src/cli.ts` trigger the same cleanup as normal exit. Cannot catch SIGKILL.

### Stage 4: CI Always Cleanup (Shell Script)

**File:** `scripts/ci/cleanup.sh`

A bash script that performs the same operations as the TypeScript `Cleanup` class. Run as a safety net in CI workflows with `if: always()`.

Operations:
1. `docker rm -f awf-squid awf-agent`
2. `docker compose -f /tmp/awf-*/docker-compose.yml down -v`
3. Remove `FW_WRAPPER` iptables chain from `DOCKER-USER`
4. `docker network rm awf-net`
5. `docker container prune -f`
6. `docker network prune -f` (critical for subnet pool management)
7. `rm -rf /tmp/awf-*`

### Why Multi-Stage?

The `timeout` command used in CI can SIGKILL the AWF process after a grace period, bypassing stages 2-3. Without stages 1 and 4, orphaned Docker networks accumulate and eventually exhaust the subnet pool ("Pool overlaps" errors).

---

## CI Workflow Post-Processing

### `scripts/ci/postprocess-smoke-workflows.ts`

After `gh-aw compile` generates `.lock.yml` workflow files, this script transforms them for CI use:

| Transformation | Why |
|----------------|-----|
| Replace "Install awf binary" step with `npm ci && npm run build` | Use locally-built code instead of pre-built GHCR binary |
| Remove `sparse-checkout` blocks | Full repo checkout needed for npm build |
| Remove `depth: 1` shallow clone | Full checkout needed |
| Replace `--image-tag X --skip-pull` with `--build-local` | Use locally-built container images |

Processes 29 workflow files (5 smoke, 8 build-test, 13 agentic, 3 secret-digger) across the suite. Note: the script currently expects `.github/workflows/smoke-gemini.lock.yml`; if that workflow does not exist, either add it or update the script to keep the expected workflow list in sync. Ensures CI tests use the current source code rather than stale published images.

---

## Limitations

### 1. Serial Execution Only

`maxWorkers: 1` means all 26 test files run sequentially. A full integration suite run takes **30-60+ minutes** depending on the number of container startups.

**Root cause:** All tests share the same Docker network (`172.30.0.0/24`), container names (`awf-squid`, `awf-agent`), and iptables chains. Parallel execution would cause conflicts.

### 2. No Per-Test Isolation

Tests within a `describe` block share the same `AwfRunner` instance. While each `runWithSudo()` call creates a fresh container, there's no mechanism to isolate host-level side effects (iptables rules, Docker networks) between individual tests.

### 3. Batch Runner Loses Individual stderr

The batch runner merges stdout and stderr (`2>&1`), so per-command stderr is mixed into stdout. Tests can't distinguish between a command's stdout and stderr output.

### 4. Log-Based Matchers Require `keepContainers`

`toAllowDomain` and `toBlockDomain` read Squid logs from the work directory, which is deleted during normal cleanup. Tests using these matchers must pass `keepContainers: true` and manually call `cleanup()` after assertions.

### 5. Timeout Duplication

Every test has **two timeout values**: the AWF timeout in `AwfOptions` (default 120s) and the Jest test timeout (the second argument to `test()`). These must be kept in sync manually, with the Jest timeout always exceeding the AWF timeout.

### 6. No Retry Logic

Flaky tests (network issues, Docker daemon slowness) have no built-in retry mechanism. The test infrastructure treats every failure as final.

### 7. Docker Dependency

All integration tests require:
- Docker daemon running
- sudo access for iptables
- Port 3128 available for Squid
- The `172.30.0.0/24` subnet unoccupied

This makes local development testing impossible without a Linux environment with Docker.

### 8. Cleanup Is Aggressive

`docker container prune -f` and `docker network prune -f` in the cleanup routine can affect non-AWF containers and networks on the same host. This is safe in CI but could be problematic in shared development environments.

---

## Improvement Opportunities

### 1. Dynamic Network Allocation

Instead of hardcoding `172.30.0.0/24`, assign a unique subnet per test run. This would enable limited parallelism (2-3 workers) and eliminate "Pool overlaps" errors at the source.

### 2. Test Grouping by Domain Config

The batch runner already groups commands by `AwfOptions`. This pattern could be extended: tests that share `allowDomains` and other config could be automatically grouped into fewer container invocations, even across test files.

### 3. Container Caching / Reuse

For tests that share the same `allowDomains` config, the Squid proxy container could be kept running between tests, avoiding the ~10s container startup per invocation. Only the agent container would need to restart.

### 4. Parallel-Safe Container Names

Using unique prefixes (e.g., `awf-<random>-squid` instead of `awf-squid`) would allow multiple test runs or workers simultaneously.

### 5. Flaky Test Retry

A Jest `retryTimes` configuration or custom retry wrapper for network-dependent tests would improve CI reliability without masking real failures.

### 6. Separate stderr in Batch Runner

The batch runner could be enhanced to capture stderr separately by writing it to a temp file:
```bash
(cmd) 2>/tmp/batch_stderr_name
```
This would preserve per-command stderr for better failure diagnostics.

### 7. Automatic Timeout Synchronization

A helper that sets both the AWF timeout and the Jest timeout from a single value would eliminate the timeout duplication issue:
```typescript
function testWithTimeout(name, fn, timeoutMs) {
  const awfTimeout = timeoutMs - 30000; // Buffer for container lifecycle
  test(name, () => fn(awfTimeout), timeoutMs);
}
```

### 8. Targeted Cleanup

Replace `docker container/network prune -f` with targeted removal of AWF-specific resources only (e.g., by label or name pattern). This would make the cleanup safe for shared environments.

### 9. Test Fixture for Common Assertions

Many tests repeat the same pattern: run a curl command, check `toSucceed()` or `toFail()`. A higher-level fixture could encapsulate this:
```typescript
await expectDomainAllowed(runner, 'github.com');
await expectDomainBlocked(runner, 'example.com', { allowDomains: ['github.com'] });
```

### 10. Pre-built Docker Image Caching

Integration tests that use `--build-local` rebuild containers from scratch every time. A CI-level image cache (built once, reused across tests) would save significant time.
