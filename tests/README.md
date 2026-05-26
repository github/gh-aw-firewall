# Integration Tests

TypeScript-based integration tests for the awf (Agentic Workflow Firewall) CLI.

## Overview

This directory contains comprehensive integration tests that verify firewall behavior across multiple scenarios, including:

### Core Functionality
- **Basic Firewall Functionality** (`basic-firewall.test.ts`) - Domain whitelisting, subdomain matching, exit code propagation
- **Exit Code Propagation** (`exit-code-propagation.test.ts`) - Comprehensive exit code handling tests
- **Container Working Directory** (`container-workdir.test.ts`) - Container workdir configuration

### Domain & Pattern Matching
- **Blocked Domains** (`blocked-domains.test.ts`) - Domain blocking and precedence
- **Wildcard Patterns** (`wildcard-patterns.test.ts`) - Wildcard pattern matching (*.domain.com)

### Security
- **Network Security** (`network-security.test.ts`) - Capability restrictions, bypass prevention, SSRF protection
- **Robustness Tests** (`robustness.test.ts`) - Edge cases, protocol handling, security corners

### Configuration
- **DNS Servers** (`dns-servers.test.ts`) - DNS server configuration and resolution
- **Environment Variables** (`environment-variables.test.ts`) - Environment variable passing
- **Volume Mounts** (`volume-mounts.test.ts`) - Volume mount configuration

### Protocol & Network
- **Protocol Support** (`protocol-support.test.ts`) - HTTP/HTTPS, HTTP/2, IPv4/IPv6
- **Git Operations** (`git-operations.test.ts`) - Git clone, fetch, ls-remote

### Error Handling & Logging
- **Error Handling** (`error-handling.test.ts`) - Network errors, command failures, recovery
- **Log Commands** (`log-commands.test.ts`) - Log parsing and analysis

### Integration Testing
- **CLI Proxy** (`cli-proxy.test.ts`) - gh wrapper routing, token isolation, and opt-in approved-integrity live regression coverage
- **Claude Code** (`claude-code.test.ts`) - Claude Code CLI integration
- **No Docker** (`no-docker.test.ts`) - Docker-in-Docker removal verification
- **Docker Warning** (`docker-warning.test.ts`) - Docker command warning messages

## Smoke Tests

The firewall is tested via agentic workflow smoke tests that run through the actual firewall:

- **Smoke Claude** (`.github/workflows/smoke-claude.md`) - Claude engine validation
- **Smoke Copilot** (`.github/workflows/smoke-copilot.md`) - Copilot engine validation

These smoke tests use the locally built firewall and validate:
- GitHub MCP functionality
- Playwright browser automation
- File I/O operations
- Bash command execution

## Test Structure

```
tests/
├── integration/              # Integration test suites
│   ├── basic-firewall.test.ts
│   ├── blocked-domains.test.ts
│   ├── cli-proxy.test.ts
│   ├── claude-code.test.ts
│   ├── container-workdir.test.ts
│   ├── dns-servers.test.ts
│   ├── docker-warning.test.ts
│   ├── environment-variables.test.ts
│   ├── error-handling.test.ts
│   ├── exit-code-propagation.test.ts
│   ├── git-operations.test.ts
│   ├── log-commands.test.ts
│   ├── network-security.test.ts
│   ├── no-docker.test.ts
│   ├── protocol-support.test.ts
│   ├── robustness.test.ts
│   ├── volume-mounts.test.ts
│   └── wildcard-patterns.test.ts
├── fixtures/                 # Reusable test utilities
│   ├── cleanup.ts            # Docker resource cleanup
│   ├── awf-runner.ts         # Execute awf commands
│   ├── docker-helper.ts      # Docker operations
│   ├── log-parser.ts         # Parse Squid/iptables logs
│   └── assertions.ts         # Custom Jest matchers
├── setup/
│   ├── jest.integration.config.js  # Jest configuration
│   └── jest.setup.ts               # Test setup
└── README.md                 # This file
```

## Running Tests

### Prerequisites

1. **Build the project:**
   ```bash
   npm run build
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Ensure Docker is running:**
   ```bash
   docker ps
   ```

4. **Ensure sudo access:**
   Tests require sudo for iptables manipulation.

### Run All Tests

```bash
# Unit tests + Integration tests
npm run test:all
```

### Run Unit Tests Only

```bash
npm test:unit
```

### Run Integration Tests Only

```bash
npm run test:integration
```

### Run the CLI proxy approved-integrity live regression

This opt-in regression requires a running external DIFC proxy plus a GitHub token supplied via `GITHUB_TOKEN` or `GH_TOKEN`.

```bash
AWF_RUN_APPROVED_DIFC_PROXY_TESTS=1 sudo -E npm run test:integration -- cli-proxy
```

### Run Specific Test Suite

```bash
# Run volume mount tests
npm run test:integration -- volume-mounts

# Run container workdir tests
npm run test:integration -- container-workdir
```

### Run Single Test

```bash
npm run test:integration -- -t "Test 1: Basic volume mount"
```

## Test Fixtures

### AwfRunner

Helper for executing awf commands:

```typescript
import { createRunner } from '../fixtures/awf-runner';

const runner = createRunner();

// Run with sudo (required for iptables)
const result = await runner.runWithSudo('curl https://github.com', {
  allowDomains: ['github.com'],
  logLevel: 'debug',
  keepContainers: false,
});

// Check result
expect(result).toSucceed();
expect(result.exitCode).toBe(0);
```

### DockerHelper

Helper for Docker operations:

```typescript
import { createDockerHelper } from '../fixtures/docker-helper';

const docker = createDockerHelper();

// Pull image
await docker.pullImage('curlimages/curl:latest');

// Run container
await docker.run({
  image: 'curlimages/curl:latest',
  command: ['curl', 'https://github.com'],
  rm: true,
});

// Inspect container
const info = await docker.inspect('awf-squid');
const isRunning = await docker.isRunning('awf-squid');
```

### LogParser

Parser for Squid and iptables logs:

```typescript
import { createLogParser } from '../fixtures/log-parser';

const parser = createLogParser();

// Read and parse Squid logs
const entries = await parser.readSquidLog(workDir);

// Filter by decision
const allowed = parser.filterByDecision(entries, 'allowed');
const blocked = parser.filterByDecision(entries, 'blocked');

// Check if domain was allowed/blocked
const wasAllowed = parser.wasAllowed(entries, 'github.com');
const wasBlocked = parser.wasBlocked(entries, 'example.com');
```

### Cleanup

Cleanup utility for Docker resources:

```typescript
import { cleanup } from '../fixtures/cleanup';

// Run full cleanup
await cleanup(true); // true = verbose output
```

### Custom Matchers

Custom Jest matchers for firewall assertions:

```typescript
import { setupCustomMatchers } from '../fixtures/assertions';

setupCustomMatchers();

// Use custom matchers
expect(result).toSucceed();
expect(result).toFail();
expect(result).toExitWithCode(42);
expect(result).toAllowDomain('github.com');
expect(result).toBlockDomain('example.com');
expect(result).toTimeout();
```

## Configuration

Jest configuration for integration tests is in `tests/setup/jest.integration.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/../integration'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 120000, // 2 minutes per test
  maxWorkers: 1, // Run tests serially to avoid Docker conflicts
};
```

## CI/CD Integration

Tests are designed to run in GitHub Actions. See `.github/workflows/test-coverage.yml` for the workflow configuration.

Key considerations:
- Tests run with `sudo -E` to preserve environment variables
- Docker images are pre-pulled to avoid timeouts
- Cleanup runs before and after tests to prevent resource leaks
- Artifacts (logs, reports) are collected on failure

## Test Suite

The project uses TypeScript-based integration tests that run in CI via `.github/workflows/test-coverage.yml`:

**Selected integration test files:**
| Category | Test File | Description |
|----------|-----------|-------------|
| Core | `basic-firewall.test.ts` | Domain whitelisting, connectivity |
| Core | `exit-code-propagation.test.ts` | Exit code handling |
| Core | `container-workdir.test.ts` | Container working directory |
| Domains | `blocked-domains.test.ts` | Domain blocking |
| Domains | `wildcard-patterns.test.ts` | Wildcard matching |
| Security | `network-security.test.ts` | Capability restrictions, SSRF |
| Security | `robustness.test.ts` | Edge cases, bypass prevention |
| Integration | `cli-proxy.test.ts` | CLI proxy sidecar coverage, including opt-in approved-integrity gh api array regression |
| Config | `dns-servers.test.ts` | DNS configuration |
| Config | `environment-variables.test.ts` | Environment variables |
| Config | `volume-mounts.test.ts` | Volume mounts |
| Protocol | `protocol-support.test.ts` | HTTP/HTTPS, HTTP/2 |
| Protocol | `git-operations.test.ts` | Git over HTTPS |
| Errors | `error-handling.test.ts` | Error scenarios |
| Logging | `log-commands.test.ts` | Log parsing |
| Integration | `claude-code.test.ts` | Claude Code CLI |
| Integration | `no-docker.test.ts` | Docker removal |
| Integration | `docker-warning.test.ts` | Docker warnings |

**Smoke test workflows:**
- `.github/workflows/smoke-claude.md` - Claude engine validation (uses locally built firewall)
- `.github/workflows/smoke-codex.md` - Codex engine validation (uses locally built firewall)
- `.github/workflows/smoke-copilot.md` - Copilot engine validation (uses locally built firewall)

**CI workflow:**
- All tests run with `sudo -E` for iptables manipulation
- Tests run serially to avoid Docker resource conflicts
- Automatic cleanup before and after test runs
- Test logs uploaded as artifacts on failure

## Troubleshooting

### Tests Fail with "Permission denied"

Ensure you're running with sudo:
```bash
sudo npm run test:integration
```

### Tests Timeout

Increase test timeout in `jest.integration.config.js`:
```javascript
testTimeout: 300000, // 5 minutes
```

### Docker Network Conflicts

Run cleanup before tests:
```bash
./scripts/ci/cleanup.sh
npm run test:integration
```

### Image Pull Timeouts

Pre-pull Docker images:
```bash
docker pull curlimages/curl:latest
docker pull alpine:latest
docker pull dannydirect/tinyproxy:latest
```

## Testing Patterns and Best Practices

### 1. Test Structure

Each test file follows a consistent structure:

```typescript
/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Feature Name', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);  // Clean up before tests
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);  // Clean up after tests
  });

  test('should do something', async () => {
    const result = await runner.runWithSudo('command', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 60000,
    });

    expect(result).toSucceed();
  }, 120000);  // Set individual test timeout
});
```

### 2. Use Custom Matchers

```typescript
// Check success/failure
expect(result).toSucceed();
expect(result).toFail();

// Check specific exit code
expect(result).toExitWithCode(0);
expect(result).toExitWithCode(42);

// Check timeout
expect(result).toTimeout();
```

### 3. Handle Timeouts

- Set reasonable timeouts for each test (typically 120000ms for integration tests)
- Use `--max-time` with curl to prevent indefinite hangs
- Set `timeout` in runner options

### 4. Clean Up Resources

- Always run `cleanup(false)` in `beforeAll` and `afterAll`
- Use `keepContainers: true` only when needed for log inspection
- Clean up manually created files in `afterEach`

### 5. Avoid Flaky Tests

- Use explicit timeouts with network commands
- Don't depend on timing-sensitive conditions
- Use `|| true` or error handling for expected failures
- Test for specific exit codes, not just success/failure

### 6. Group Related Tests

```typescript
describe('Feature Category', () => {
  describe('Subsection A', () => {
    test('scenario 1', ...);
    test('scenario 2', ...);
  });

  describe('Subsection B', () => {
    test('scenario 3', ...);
    test('scenario 4', ...);
  });
});
```
