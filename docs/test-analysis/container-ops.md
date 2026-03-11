# Container, Volume, and Operational Integration Tests Analysis

This document provides a detailed analysis of integration tests covering container configuration, volume mounts, environment variables, git operations, log commands, and Docker-in-Docker removal verification.

---

## Table of Contents

1. [Container Working Directory Tests](#1-container-working-directory-tests)
2. [Volume Mount Tests](#2-volume-mount-tests)
3. [Git Operations Tests](#3-git-operations-tests)
4. [Environment Variable Tests](#4-environment-variable-tests)
5. [Log Commands Tests](#5-log-commands-tests)
6. [Docker Warning Tests](#6-docker-warning-tests)
7. [No Docker Tests](#7-no-docker-tests)
8. [Cross-Cutting Gaps](#8-cross-cutting-gaps)

---

## 1. Container Working Directory Tests

**File:** `tests/integration/container-workdir.test.ts`

### What It Tests

| Test | Description |
|------|-------------|
| Default working directory | Verifies that when `--container-workdir` is not specified, the container starts with `/workspace` as the working directory (Dockerfile default) |
| Custom working directory | Verifies `--container-workdir /tmp` changes the working directory |
| Command execution in workdir | Creates a file and lists it from `/tmp`, confirming commands execute relative to the custom workdir |
| Home directory as workdir | Sets workdir to `$HOME` (from host `process.env.HOME`), verifies it resolves correctly |
| Relative path navigation | Runs `cd .. && pwd` from `/tmp` to verify relative paths work from within the workdir |

### Real-World Mapping

This maps directly to how gh-aw invokes AWF via `BuildAWFArgs()` in `pkg/workflow/awf_helpers.go`. The `--container-workdir` flag is used to set the agent's working directory to the cloned repository directory (typically `/home/runner/work/repo/repo` on Actions runners). Getting this wrong means the AI agent can't find the code it needs to work on.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **Non-existent directory** | High | What happens if `--container-workdir /nonexistent` is specified? Should it fail or create the dir? |
| **Directory with spaces** | Medium | Paths like `--container-workdir "/my project"` could break shell quoting |
| **Deeply nested path** | Low | A path like `/a/b/c/d/e/f/g` that doesn't exist |
| **Permissions on workdir** | High | Verify the agent user can write to the custom workdir (not just navigate to it) |
| **Interaction with volume mounts** | High | When `--container-workdir /data` is set AND `--mount /host/dir:/data:ro` is used, can the agent navigate correctly? |
| **Workdir inside chroot** | Medium | In chroot mode, `/workspace` maps differently — no test verifies chroot + workdir interaction |

### Edge Cases

- Setting workdir to `/` (root filesystem)
- Setting workdir to a symlinked directory
- Setting workdir to a directory owned by a different user

---

## 2. Volume Mount Tests

**File:** `tests/integration/volume-mounts.test.ts`

### What It Tests

| Test # | Test Name | Description |
|--------|-----------|-------------|
| 1 | Read-only custom mount | Host file at `testDir/test.txt` → mounted at `/data/test.txt:ro` → agent can read it |
| 2 | Read-write custom mount | Container writes to `/data/output.txt` → file appears on host filesystem |
| 3 | Multiple custom mounts | Two separate directories mounted at `/mount1` and `/mount2` — both accessible |
| 4 | Blanket mount removed | When custom mounts are provided, host paths outside mounts are NOT accessible (security isolation) |
| 5 | No /host mount | With custom mounts, `/host` (the full host filesystem) is not mounted (verified by `ls /host` failing) |
| 6 | Essential mounts (HOME) | Even with custom mounts, `$HOME` is still set and its directory exists |
| 7 | Backward compatibility | Without custom mounts, `/host` blanket mount is present (legacy default behavior) |
| 8 | Default mode is rw | Mount without `:ro` or `:rw` suffix defaults to read-write |
| 9 | Debug logging | Debug logs contain a message about custom volume mount configuration |
| 10 | Current working directory | Mounts a project directory at `/workspace` and reads a file from it |
| 11 | Mixed ro/rw mounts | One directory mounted as `:ro` (reads config), another as `:rw` (writes log) |

### Real-World Mapping

Volume mounts are central to AWF's value proposition. In production gh-aw workflows:
- **Test 4-5 (security isolation):** When custom mounts are specified, the agent should ONLY see what it's given. This prevents a compromised agent from reading SSH keys, cloud credentials, or other sensitive host files.
- **Test 7 (backward compatibility):** The default "blanket mount" mode (`/host`) is how chroot mode works — the entire host FS is mounted read-only with specific writable overlays.
- **Test 10 (workspace mount):** Maps to the typical gh-aw pattern of mounting the cloned repo directory as `/workspace`.
- **Test 11 (mixed):** Maps to mounting source code as read-only but a build output directory as read-write.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **Read-only enforcement** | Critical | Test 1 verifies reading works on `:ro` mounts, but does NOT verify that WRITING to a `:ro` mount FAILS. This is a security property. |
| **Invalid mount paths** | High | No test for host paths that don't exist, or container paths that conflict with system dirs |
| **Mount path traversal** | High | No test for attempts to escape mount boundaries (e.g., `cat /data/../../../etc/passwd`) |
| **Symlink mounts** | Medium | Mounting a host directory that contains symlinks pointing outside the mount |
| **Large file mounts** | Low | Performance with large files or many files in mounted directory |
| **Mount over system directories** | High | What happens if you mount to `/usr`, `/etc`, or `/bin`? |
| **Empty directory mount** | Low | Mounting an empty directory |
| **File (not directory) mount** | High | CLAUDE.md explicitly warns against file bind mounts due to atomic write issues. No test validates this limitation or documents the failure mode. |
| **Nested mount paths** | Medium | E.g., mounting `/data` and `/data/subdir` separately |
| **Mount with special chars in path** | Medium | Paths containing spaces, unicode, or shell metacharacters |

### Edge Cases

- Mount the same host directory to two different container paths
- Mount a FIFO or device file
- Mount a directory on a different filesystem (e.g., NFS, tmpfs)
- Concurrent writes from host and container to the same rw mount

---

## 3. Git Operations Tests

**File:** `tests/integration/git-operations.test.ts`

### What It Tests

| Test | Description |
|------|-------------|
| git ls-remote to allowed domain | `git ls-remote` to `github.com` succeeds, returns a commit hash |
| git ls-remote to subdomain | Same as above (tests subdomain matching, though the URL is identical — likely a test naming issue) |
| git ls-remote blocked | `git ls-remote` to `gitlab.com` fails when only `github.com` is allowed |
| git clone allowed | `git clone --depth 1` of a public repo succeeds, contains README |
| git clone blocked | `git clone` from `gitlab.com` fails |
| git config --global list | Git global config can be read/listed |
| git config set | Can set `user.email` via `git config --global` and read it back |
| Sequential git operations | Two `git ls-remote` commands back-to-back both succeed |

### Real-World Mapping

Git operations are the most common network activity in agentic workflows. Every AI agent that works on code needs to:
1. Clone the repository (or it's pre-cloned on the runner)
2. Fetch remote refs to check for updates
3. Push commits (if the workflow creates PRs)

The firewall must transparently proxy HTTPS git operations through Squid. Git uses HTTPS CONNECT tunnels, which map to Squid's `TCP_TUNNEL` decision.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **git push** | Critical | No test for `git push` — the most important write operation in agentic workflows. Agents create branches and push PRs. |
| **git with authentication** | Critical | No test with `GITHUB_TOKEN` or PAT. Production agents always use authenticated git to push and access private repos. The test header mentions "Git with authentication" but no such test exists. |
| **git fetch** | High | Listed in the file header but not actually tested. `git fetch` inside an existing clone is a common operation. |
| **git submodule operations** | Medium | Submodules require fetching from potentially different domains |
| **git over SSH** | Low | AWF blocks non-HTTP(S), but no test confirms git-over-SSH fails gracefully |
| **git LFS** | Medium | Large File Storage uses different endpoints that may need separate domain allowlisting |
| **Concurrent git operations** | Low | Multiple parallel clones/fetches |
| **git with custom proxy config** | Medium | Does `git config http.proxy` interact with AWF's transparent proxy? |
| **Subdomain test is a duplicate** | Bug | "should allow git ls-remote to subdomain" uses exactly the same URL as the first test (`github.com`). Should test actual subdomain like `api.github.com` or `gist.github.com`. |

### Edge Cases

- Git operation that exceeds Squid's idle timeout
- Repository with very large history (timeout during clone)
- `git push --force` (should be blocked by workflow permissions, not firewall, but worth noting)
- Git credential helper interactions

---

## 4. Environment Variable Tests

**File:** `tests/integration/environment-variables.test.ts`

### What It Tests

| Test | Description |
|------|-------------|
| Single env var | `-e TEST_VAR=hello_world` is passed to container, `echo $TEST_VAR` outputs it |
| Multiple env vars | Three variables (`VAR1`, `VAR2`, `VAR3`) all reach the container |
| Special characters | Value with spaces (`"value with spaces"`) is correctly preserved |
| Empty value | An empty string value is detected as empty inside the container |
| PATH preservation | Default `PATH` inside the container includes `/usr/bin` or `/bin` |
| HOME set | `$HOME` is set to `/root` or `/home/*` |
| No sensitive leakage | `printenv | grep TOKEN|SECRET|PASSWORD|KEY` shows nothing by default |
| Numeric values | String `"12345"` passed as env var arrives correctly |

### Real-World Mapping

Environment variables are how secrets and configuration flow into agentic workflows:
- `GITHUB_TOKEN` — for Git operations and API calls
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — for AI engine API calls
- `HOME` / `PATH` — for tool discovery and configuration
- Custom env vars from workflow `env:` blocks

The `--env-all` flag is used in production by gh-aw's `BuildAWFArgs()` to pass all GitHub Actions environment variables (including secrets) into the container.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **`--env-all` flag** | Critical | The file header mentions it but NO test actually uses `envAll: true`. This is the primary mode used in production. |
| **Env var with equals sign in value** | High | `KEY=value=with=equals` — the parsing uses first `=` as delimiter, but no test verifies |
| **Env var with newlines** | High | Multi-line values (common in PEM certificates, SSH keys) |
| **Env var with shell metacharacters** | Medium | Values containing `$`, backticks, `$(...)` that could be expanded |
| **Very long env var values** | Low | Docker has limits on environment variable size |
| **Env var overriding system vars** | High | What happens if `-e PATH=/empty` or `-e HOME=/nonexistent` is passed? |
| **Proxy env vars** | High | AWF sets `HTTP_PROXY`, `HTTPS_PROXY` internally. No test verifies these exist inside the container or that user-provided proxy vars don't conflict. |
| **JAVA_TOOL_OPTIONS** | Medium | AWF sets JVM proxy properties. No test verifies this. |
| **Env var ordering/precedence** | Medium | If the same key is specified twice, which value wins? |
| **Sensitive var leakage test is weak** | High | The "no sensitive leakage" test just greps for keywords in printenv. It doesn't set actual secrets on the host and verify they DON'T appear. The comment even acknowledges "This depends on what's in the host environment." |

### Edge Cases

- Unicode characters in env var names or values
- Env var names with dots (e.g., `npm_config_registry`)
- Boolean-like values (`true`, `false`, `0`, `1`)
- Env vars that Docker treats specially (e.g., `DOCKER_HOST`)

---

## 5. Log Commands Tests

**File:** `tests/integration/log-commands.test.ts`

### What It Tests

**Live Integration Tests (3 tests):**

| Test | Description |
|------|-------------|
| Log generation | Runs `curl` through AWF with `--keep-containers`, verifies `squid-logs/access.log` is created and non-empty |
| Log parsing | Runs two curls (one allowed, one blocked), reads the log file, and verifies parsed entries have required fields (`timestamp`, `host`, `statusCode`, `decision`) |
| Allowed vs blocked distinction | Same two-curl setup, filters entries by decision type (`allowed` vs `blocked`), verifies at least one entry exists |

**Unit Tests for LogParser (4 tests):**

| Test | Description |
|------|-------------|
| Squid log format parsing | Parses a synthetic log line, verifies `host`, `statusCode`, `decision` fields |
| Blocked entry identification | Parses a `TCP_DENIED` / 403 log line, confirms it's classified as blocked |
| Unique domains | Parses 3 entries (2 unique domains), verifies deduplication |
| Domain filtering | Filters by `github.com` subdomain matching |

### Real-World Mapping

Log analysis is critical for:
1. **GitHub Actions step summaries** — `awf logs summary >> $GITHUB_STEP_SUMMARY` shows what domains were accessed/blocked
2. **Debugging blocked requests** — when an agent fails because a required domain isn't in the allowlist
3. **Security auditing** — reviewing what external services an agent contacted
4. **Compliance** — proving that sensitive internal services weren't accessed

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **`awf logs stats` command** | High | The stats subcommand is never actually invoked end-to-end. Only the parser is unit-tested. |
| **`awf logs summary` command** | High | Similarly never invoked as a real CLI command |
| **`awf logs` command (view)** | High | The base `logs` command with `--follow`, `--format`, etc. is never tested |
| **JSON output format** | Medium | Stats/summary can output JSON — not tested |
| **Markdown output format** | Medium | Summary defaults to markdown — not tested |
| **Pretty output format** | Medium | Stats defaults to pretty — not tested |
| **`--source` flag** | Medium | Specifying custom log source path |
| **`--list` flag** | Medium | Listing available log sources |
| **Empty logs** | Medium | What do commands output when no logs exist? |
| **Integration tests are fragile** | High | All 3 live tests have `if (fs.existsSync(...))` guards that silently pass when logs aren't created. A timing issue could make the test pass vacuously. |
| **Log rotation / large logs** | Low | Behavior with very large access logs |
| **iptables log parsing** | Medium | The `LogParser` has `parseIptablesLog()` and `readIptablesLog()` methods that are never tested in integration |

### Edge Cases

- Concurrent requests producing interleaved log entries
- Log entries with unusual User-Agent strings containing quotes
- Very long URLs in log entries
- Squid log buffering delays (tests already work around this with `setTimeout(1000)`)

---

## 6. Docker Warning Tests

**File:** `tests/integration/docker-warning.test.ts`

### What It Tests

**NOTE: This entire test suite is `describe.skip`'d due to a Node.js build issue in local container images.**

| Test | Description |
|------|-------------|
| docker run warning | Running `docker run alpine echo hello` shows a helpful error about DinD removal (v0.9.1) |
| docker-compose warning | `docker-compose up` fails (docker-compose not installed) |
| which docker | `which docker` shows `/usr/bin/docker` exists (stub script) |
| docker --help | Shows the DinD removal warning and link to breaking changes |
| docker version | Fails with helpful error message |

### Real-World Mapping

Docker-in-Docker was removed in v0.9.1 (PR #205) because it was a security risk and unnecessary for agentic workflows. These tests verify that when agents try to use Docker (which some MCP servers or build tools might attempt), they get a clear error message rather than a confusing failure.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **Tests are entirely skipped** | Critical | The entire suite is `describe.skip`. These tests provide zero coverage. The comment says "tests will be enabled once the build issue is fixed" — this is a stale TODO. |
| **Requires `buildLocal: true`** | Context | These tests only work with locally-built images that include the Docker stub script. The GHCR images may or may not have the stub. |
| **No equivalent in `no-docker.test.ts`** | — | The `no-docker.test.ts` file covers the same scenario from a different angle (see below). |

### Edge Cases

- N/A (tests are skipped)

---

## 7. No Docker Tests

**File:** `tests/integration/no-docker.test.ts`

### What It Tests

| Test | Description |
|------|-------------|
| docker not available | `which docker` fails (docker-cli not installed in container) |
| docker run fails gracefully | `docker run alpine echo hello` fails with stderr containing "docker" or "not found" |
| docker-compose not available | `which docker-compose` fails |
| docker socket not mounted | `/var/run/docker.sock` is not present in the container |

### Real-World Mapping

This is the complement to the docker-warning tests. While docker-warning tests verify the stub script provides helpful messages (when building locally), these tests verify the baseline: Docker is simply not available in GHCR images. This is a key security property — the agent cannot escape the firewall by starting new containers.

### Gaps and Missing Coverage

| Gap | Priority | Rationale |
|-----|----------|-----------|
| **docker buildx / docker compose (plugin)** | Medium | The new `docker compose` (without hyphen) is a plugin. Not tested. |
| **containerd / nerdctl** | Low | Alternative container runtimes that could be present |
| **podman** | Low | Another alternative runtime |
| **Interplay with buildLocal** | Medium | When `buildLocal: true` is used, the docker-warning stub IS installed. These tests don't use `buildLocal`, so they test a different code path. No test covers both paths in the same suite. |
| **Socket at alternative paths** | Low | Docker socket can be at non-default paths |

### Edge Cases

- Agent installing Docker via `apt-get` (should fail due to network restrictions unless docker.io is in allowlist)
- Agent downloading a static Docker binary via curl (should fail unless the download domain is allowed)

---

## 8. Cross-Cutting Gaps

### Architectural Gaps

| Gap | Description | Affected Tests |
|-----|-------------|----------------|
| **Chroot mode interaction** | None of these operational tests verify behavior in chroot mode. All use the default container mode. Chroot changes path semantics significantly. | All files |
| **`--env-all` never tested** | The most commonly used env mode in production is completely untested | environment-variables |
| **Cleanup verification** | Tests call `cleanup()` in beforeAll/afterAll but never verify cleanup succeeded. If cleanup fails silently, tests may interfere with each other. | All files |
| **Signal handling** | No test sends SIGINT/SIGTERM to AWF during operation and verifies cleanup | All files |
| **Timeout behavior** | No test verifies what happens when the agent command exceeds `--timeout` | All files |
| **`--keep-containers` interaction** | Only log-commands tests use `keepContainers: true`. No test verifies the flag preserves containers AND that subsequent cleanup removes them. | log-commands |
| **Error messages** | No test verifies user-facing error messages for invalid inputs (bad mount format, invalid workdir, etc.) | volume-mounts, container-workdir |

### Test Infrastructure Observations

1. **Fragile log assertions:** The log-commands tests use `if (fs.existsSync(...))` guards that allow tests to pass even when no logs are generated. This should be `expect(fs.existsSync(...)).toBe(true)` to avoid false positives.

2. **Duplicate subdomain test:** In `git-operations.test.ts`, "should allow git ls-remote to subdomain" uses the exact same URL as the first test. It should use an actual subdomain like `gist.github.com`.

3. **Test isolation:** Each test spins up a full Docker environment (Squid + Agent containers), which takes 20-60 seconds. This makes the test suite slow (~10-15 minutes total) but provides high-fidelity end-to-end coverage.

4. **Environment dependency:** Several tests depend on the host having Docker, sudo access, and network connectivity to github.com. This makes them unsuitable for offline or restricted CI environments.

5. **Timeout margins:** Most individual test timeouts are 120s while the inner command timeouts are 30-60s. This provides a reasonable margin, but some tests (git clone) could be tight on slow networks.

### Missing Test Categories

| Category | Description |
|----------|-------------|
| **Concurrent operations** | No test runs multiple AWF instances simultaneously to verify network isolation |
| **Resource limits** | No test for container memory/CPU limits |
| **Filesystem permissions** | Limited testing of file ownership (UID/GID) inside the container |
| **Binary execution** | No test compiles or runs a binary inside the container |
| **Network partition** | No test for behavior when Docker network is unavailable or degraded |
| **Upgrade/migration** | No test for behavior differences between image versions |
