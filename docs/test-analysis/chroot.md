# Chroot Integration Tests Analysis

This document provides a detailed analysis of all chroot integration test files in the `gh-aw-firewall` project, covering what each test validates, how it maps to real-world usage, and identifying gaps in coverage.

## Table of Contents

- [Test Infrastructure Overview](#test-infrastructure-overview)
- [1. chroot-languages.test.ts](#1-chroot-languagestestts)
- [2. chroot-package-managers.test.ts](#2-chroot-package-managerstestts)
- [3. chroot-edge-cases.test.ts](#3-chroot-edge-casestestts)
- [4. chroot-copilot-home.test.ts](#4-chroot-copilot-hometestts)
- [5. chroot-procfs.test.ts](#5-chroot-procfstestts)
- [Cross-File Gap Analysis](#cross-file-gap-analysis)

---

## Test Infrastructure Overview

### Execution Model
All chroot tests use `AwfRunner.runWithSudo()` which invokes `sudo -E node dist/cli.js` with preserved environment variables (`PATH`, `HOME`, `GOROOT`, `CARGO_HOME`, `JAVA_HOME`, `DOTNET_ROOT`). Each invocation spins up a full Docker Compose stack (Squid proxy + agent container).

### Batch Runner Optimization
Tests that share the same `allowDomains` config are batched into a single AWF container invocation using `runBatch()`. This concatenates commands into a single bash script with delimiter tokens, parsing per-command results from the combined output. This reduces ~73 container startups to ~27 across the suite.

### Custom Matchers
- `toSucceed()` - exit code 0
- `toFail()` - non-zero exit code
- `toExitWithCode(n)` - specific exit code
- `toAllowDomain(domain)` / `toBlockDomain(domain)` - Squid log inspection

### Chroot Architecture Under Test
The agent container mounts the host filesystem at `/host`, then calls `chroot /host` so all paths resolve naturally. Key features:
- Selective path mounting (not full `/` mount by default)
- Empty writable `$HOME` with specific subdirectory overlays
- Dynamic `/proc` mount via `mount -t proc` (not static bind mount)
- Capability drop (`NET_ADMIN`, `SYS_CHROOT`, `SYS_ADMIN`) before user code runs
- UID/GID remapping to match host user

---

## 1. chroot-languages.test.ts

**Purpose:** Verifies that host-installed language runtimes are accessible through the chroot filesystem. Critical for GitHub Actions runners where tools are pre-installed at the host level.

### Test Cases

#### Batched Quick Checks (single container invocation)

| Test | Command | What It Validates |
|------|---------|-------------------|
| Python version | `python3 --version` | Python3 binary accessible via chroot PATH |
| Python inline | `python3 -c "print(2 + 2)"` | Python interpreter executes inline scripts |
| Python stdlib | `python3 -c "import json, os, sys; ..."` | Python standard library modules load correctly |
| pip version | `pip3 --version` | pip package manager accessible |
| Node.js version | `node --version` | Node.js binary accessible |
| Node.js inline | `node -e "console.log(2 + 2)"` | Node.js evaluates inline JS |
| Node.js modules | `node -e "require('os').platform()"` | Node.js built-in modules resolve |
| npm version | `npm --version` | npm binary accessible |
| npx version | `npx --version` | npx binary accessible |
| Go version | `go version` | Go binary accessible |
| Go env | `go env GOVERSION` | Go environment properly configured |
| Java version | `java --version` | JDK accessible (fallback: `java -version`) |
| .NET version | `dotnet --version` | .NET SDK accessible |
| .NET info | `dotnet --info` | .NET runtime information available |
| Unix utils | `which bash && which ls && which cat` | Core Unix utilities accessible |
| Git version | `git --version` | Git binary accessible |
| curl version | `curl --version` | curl binary accessible |

#### Individual Tests (separate containers)

| Test | What It Validates |
|------|-------------------|
| Java compile + run | Creates Hello.java, compiles with `javac`, runs with `java` - validates full JDK toolchain |
| Java stdlib (java.util) | Compiles and runs code using `java.util.Arrays` and `java.util.List` |
| .NET create + run | `dotnet new console` + `dotnet restore` + `dotnet run` - validates full SDK workflow (requires NuGet domains) |

### Real-World Mapping

| Test Area | Real-World Scenario |
|-----------|-------------------|
| Python | Claude/Copilot agents installing Python packages, running Python scripts in AI-generated code |
| Node.js/npm | Copilot CLI itself is a Node.js tool; agents run `npm install`, build JS projects |
| Go | Agents building Go projects (common in GitHub Actions context) |
| Java | Agents compiling Java projects with Maven/Gradle (enterprise workflows) |
| .NET | Agents building .NET projects, NuGet restore for dependencies |
| Git | Every agent workflow uses git (clone, commit, push) |
| curl | Agents fetching APIs, downloading artifacts |

### Gaps and Missing Coverage

1. **No Rust compile test** - Rust is tested in package-managers but only for `cargo --version` and `rustc --version`. No `cargo build` or `rustc` compile test exists here, despite Rust being a primary language for AWF users.

2. **No Python virtual environment test** - Real agents frequently create venvs (`python3 -m venv`). The chroot filesystem might not handle venv creation correctly (symlinks, activation scripts).

3. **No TypeScript compilation test** - `tsc` or `tsx` are common in agent workflows but never tested.

4. **No Bun runtime test** - Bun is explicitly supported in `entrypoint.sh` (AWF_BUN_INSTALL) but has no corresponding test.

5. **No multi-language interaction test** - Real agents often chain languages (e.g., Python script calling a Node.js tool), which could fail if PATH ordering is wrong.

6. **No dynamic library loading test** - Tests only check binary execution. Shared library loading (`ld.so.cache`, `/lib64/`) is implicitly tested but not explicitly verified.

7. **Java version check uses fallback pattern** - `java --version 2>&1 || java -version 2>&1` catches both formats, but doesn't verify which Java version is found (could pick up wrong JDK).

8. **Soft failures on network tests** - `.NET` test uses `if (result.success)` guard, meaning the test passes even if .NET can't reach NuGet. This hides real failures.

---

## 2. chroot-package-managers.test.ts

**Purpose:** Validates that package managers can perform network operations through the firewall with proper domain whitelisting. Tests both online (with allowed domains) and offline behaviors.

### Test Cases

#### pip (Python)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| pip list | pypi.org, files.pythonhosted.org | Lists installed packages (verifies pip can read local package DB) |
| pip index versions | pypi.org, files.pythonhosted.org | Queries PyPI registry through firewall |
| pip show pip | localhost only | Shows package info without network (offline capability) |

#### npm (Node.js)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| npm config list | registry.npmjs.org | npm configuration accessible |
| npm view chalk version | registry.npmjs.org | npm queries registry through firewall |
| npm view (blocked) | localhost only | npm registry access is blocked without domain whitelisting |

#### Rust (cargo)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| cargo version | crates.io, static.crates.io, index.crates.io | Cargo binary accessible via chroot |
| cargo search serde | crates.io, static.crates.io, index.crates.io | Cargo can search crates.io through firewall |
| rustc version | localhost only | rustc binary accessible (offline) |

#### Java (maven)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| java version | localhost only | Java runtime accessible |
| javac version | localhost only | Java compiler accessible |
| mvn version | repo.maven.apache.org, repo1.maven.org | Maven binary accessible with repository domains |

#### .NET (dotnet/nuget)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| dotnet list-sdks | localhost only | SDK listing works offline |
| dotnet list-runtimes | localhost only | Runtime listing works offline |
| dotnet create + build | api.nuget.org, nuget.org, dotnetcli.azureedge.net | Full project lifecycle with NuGet restore |
| dotnet restore (blocked) | localhost only | NuGet restore fails without domain whitelisting |

#### Ruby (gem/bundler)

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| ruby version | localhost only | Ruby binary accessible |
| gem list (local) | localhost only | Lists locally installed gems |
| gem version | rubygems.org, index.rubygems.org | gem binary accessible with registry domains |
| bundler version | rubygems.org, index.rubygems.org | Bundler binary accessible |
| gem search rails | rubygems.org, index.rubygems.org | gem can search rubygems.org through firewall |

#### Go modules

| Test | Domains Allowed | What It Validates |
|------|----------------|-------------------|
| go env GOPATH GOPROXY | proxy.golang.org, sum.golang.org | Go module proxy configuration correct |
| go mod init + tidy | localhost only | Go module initialization works offline |

### Real-World Mapping

| Test Area | Real-World Scenario |
|-----------|-------------------|
| pip + PyPI | Copilot/Claude agents running `pip install` for Python dependencies in AI-generated code |
| npm + registry | Agents running `npm install` for JS/TS projects; Copilot CLI itself needs npm |
| cargo + crates.io | Agents building Rust projects, adding dependencies with `cargo add` |
| maven | Agents building Java enterprise projects with Maven |
| dotnet + NuGet | Agents building .NET projects, adding NuGet packages |
| gem + rubygems | Agents working with Ruby projects, installing gems |
| go modules | Agents working with Go projects, fetching module dependencies |
| Blocking tests | Ensures firewall actually blocks unauthorized network access - critical security property |

### Gaps and Missing Coverage

1. **No pip install test** - Tests query PyPI index but never actually install a package. `pip install requests` through the firewall would be a more realistic test.

2. **No npm install test** - Tests `npm view` but never `npm install`. Real agents always install packages.

3. **No cargo build/add test** - Tests `cargo search` but never `cargo add` or `cargo build` with dependencies.

4. **No Gradle test** - Maven is tested but Gradle (also very common in Java) is completely absent. `entrypoint.sh` even pre-seeds `~/.gradle/gradle.properties` for proxy config but this is never tested.

5. **No sbt/Scala test** - JVM proxy flags are set via `JAVA_TOOL_OPTIONS` for sbt but never tested.

6. **No pip blocking test** - npm and .NET have explicit "blocked without domain" tests, but pip does not. There's no test verifying that `pip install` fails when PyPI is not whitelisted.

7. **No cargo blocking test** - Same gap as pip - no test verifying cargo is blocked without crates.io domains.

8. **No gem install test** - Tests `gem search` but never `gem install`. Real-world Ruby workflows install gems.

9. **Soft failure pattern** - Multiple tests use `if (result.exitCode === 0)` or `if (result.success)` guards, meaning the test passes even on failure. This is appropriate for CI flakiness tolerance but masks real regressions.

10. **No proxy configuration verification** - Tests verify tools can reach registries but don't verify proxy env vars are correctly set. A test checking `echo $HTTP_PROXY` would confirm proxy configuration.

---

## 3. chroot-edge-cases.test.ts

**Purpose:** Validates edge cases, security features, error handling, and shell compatibility within the chroot environment.

### Test Cases

#### General Checks (batched)

| Test | Command | What It Validates |
|------|---------|-------------------|
| PATH preserved | `echo $PATH` | PATH includes `/usr/bin` and `/bin` |
| HOME set | `echo $HOME` | HOME env var points to a valid path |
| /usr readable | `ls /usr/bin` | Host `/usr/bin` accessible through chroot |
| /etc readable | `cat /etc/passwd` | Host `/etc/passwd` accessible (contains "root") |
| /tmp writable | Write + read + delete in /tmp | Temp directory is writable |
| Docker socket hidden | Check `/var/run/docker.sock` | Docker socket is NOT accessible (security) |
| NET_ADMIN dropped | `iptables -L` | Cannot list iptables rules (permission denied) |
| chroot prevented | `chroot / /bin/true` | Cannot use chroot command (capability dropped) |
| Shell pipes | `echo "hello" \| grep hello` | Pipe operator works in chroot |
| Shell redirect | Write via `>` and read back | Redirection works in chroot |
| Command substitution | `echo "Today is $(date +%Y)"` | `$()` substitution works |
| Compound commands | `echo "first" && echo "second" && echo "third"` | `&&` chaining works |
| Non-root user | `id -u` | UID is not 0 (running as non-root) |
| Username set | `whoami` | Username is not "root" |

#### Working Directory Handling (individual tests)

| Test | What It Validates |
|------|-------------------|
| Respect container-workdir | `pwd` with `containerWorkDir: '/tmp'` returns `/tmp` |
| Fallback for nonexistent dir | `pwd` with nonexistent `containerWorkDir` falls back to home |

#### Exit Code Propagation (individual tests)

| Test | What It Validates |
|------|-------------------|
| Exit code 0 | `exit 0` propagates correctly |
| Exit code 1 | `exit 1` propagates correctly |
| Failed command | `false` returns exit code 1 |
| Command not found | `nonexistent_command_xyz123` returns exit code 127 |

#### Network Firewall Enforcement (individual tests)

| Test | What It Validates |
|------|-------------------|
| Allow HTTPS | `curl -s -o /dev/null -w "%{http_code}" https://api.github.com` succeeds with whitelisted domain |
| Block HTTPS | `curl -s --connect-timeout 5 https://example.com` fails when example.com not whitelisted |
| Block HTTP | `curl -f --connect-timeout 5 http://example.com` fails when example.com not whitelisted |

### Real-World Mapping

| Test Area | Real-World Scenario |
|-----------|-------------------|
| PATH/HOME | Every agent command depends on correct environment variables |
| /usr, /etc access | Agents need host binaries and system configs |
| /tmp writable | Build tools, compilers, and agents use temp files extensively |
| Docker socket hidden | Prevents agents from escaping the firewall by spawning unrestricted containers |
| Capability drop | Prevents agents from modifying iptables to bypass firewall |
| Shell features | Agents execute complex shell commands with pipes, redirects, and substitution |
| Non-root execution | Security requirement - agents must not run as root |
| Working directory | `--container-workdir` sets where agent commands execute (typically the repo checkout) |
| Exit codes | AWF must faithfully propagate agent exit codes for CI/CD pass/fail determination |
| Network enforcement | Core firewall functionality - allow whitelisted, block everything else |

### Gaps and Missing Coverage

1. **No `--env` passthrough test** - Test for custom environment variables is explicitly skipped (`test.skip`). This is a significant gap since `--env` is a real CLI feature.

2. **No SYS_ADMIN capability drop test** - Tests verify NET_ADMIN and SYS_CHROOT are dropped but don't test SYS_ADMIN (which is dropped in chroot mode per `entrypoint.sh`).

3. **No signal handling test** - No test for SIGTERM/SIGINT propagation. The entrypoint has explicit signal handling (`trap cleanup_and_exit TERM INT`) but this is never tested.

4. **No symlink resolution test** - Chroot mode relies on symlinks (e.g., `/lib` -> `/lib/x86_64-linux-gnu`). No test verifies symlinks work correctly.

5. **No large output test** - No test for commands producing large stdout/stderr, which could test buffer handling.

6. **No `--allow-full-filesystem-access` test** - The escape hatch flag is never tested in chroot integration tests.

7. **No credential hiding test** - The selective mounting hides credential files via `/dev/null` overlays, but no test verifies that `cat ~/.docker/config.json` or `cat ~/.ssh/id_rsa` returns empty/fails.

8. **No DNS resolution test** - DNS configuration is complex in chroot mode (resolv.conf backup/restore, Docker embedded DNS + external DNS). No test verifies DNS queries resolve correctly.

9. **No concurrent process test** - No test running multiple processes simultaneously in the chroot, which could reveal issues with /proc, temp files, or resource sharing.

10. **No exit code for signals** - Tests check exit codes 0, 1, and 127, but not 128+N signal exit codes (e.g., 143 for SIGTERM).

11. **No timeout propagation test** - No test verifying that AWF's timeout mechanism works and propagates correctly.

---

## 4. chroot-copilot-home.test.ts

**Purpose:** Verifies that the GitHub Copilot CLI can access and write to `~/.copilot` directory in chroot mode. Essential for package extraction, configuration storage, and log management.

### Test Cases (all batched, single container)

| Test | Command | What It Validates |
|------|---------|-------------------|
| Write to ~/.copilot | Create dir + write file + read back | Basic write access to ~/.copilot |
| Nested directories | Create `~/.copilot/pkg/linux-x64/0.0.405/marker.txt` | Deep directory creation (mimics Copilot package extraction) |
| Permissions | `touch` + `rm` in ~/.copilot | File creation and deletion work (correct ownership) |

### Real-World Mapping

| Test | Real-World Scenario |
|------|-------------------|
| Write file | Copilot CLI writes configuration files on first run |
| Nested directories | Copilot CLI extracts bundled packages to `~/.copilot/pkg/<platform>/<version>/` |
| Permissions | Copilot CLI needs to manage its own files (create, update, delete) |

### Gaps and Missing Coverage

1. **No file persistence test** - Tests write and read within the same invocation. No test verifies files persist between AWF invocations (which they should, as ~/.copilot is bind-mounted from host).

2. **No ~/.copilot/logs test** - Copilot CLI writes logs to `~/.copilot/logs/` which is separately mounted (`${config.workDir}/agent-logs:${effectiveHome}/.copilot/logs:rw`). No test verifies log writing works.

3. **No ownership/UID test** - Files should be owned by the AWF user (not root). No test checks `ls -la ~/.copilot/test/file.txt` for correct ownership.

4. **No concurrent write test** - No test for atomic file writes (important for config files).

5. **No symlink within ~/.copilot test** - Copilot may create symlinks; no test verifies this works.

6. **No `.claude.json` creation test** - `entrypoint.sh` creates `~/.claude.json` when `CLAUDE_CODE_API_KEY_HELPER` is set. This is never tested.

7. **No other home subdirectory tests** - `~/.cache`, `~/.config`, `~/.local`, `~/.anthropic`, `~/.claude` are all mounted but only `~/.copilot` is tested for write access.

---

## 5. chroot-procfs.test.ts

**Purpose:** Validates the dynamic `/proc` filesystem mount in chroot mode. This is a regression test for commit `dda7c67` which replaced a static `/proc/self` bind mount with `mount -t proc`.

### Background

Without the dynamic proc mount:
- .NET CLR fails: "Cannot execute dotnet when renamed to bash"
- JVM misreads `/proc/self/exe` and `/proc/cpuinfo`
- Rustup proxy binaries appear as bash instead of the actual binary

### Test Cases

#### Batch 1: Quick /proc checks (single container)

| Test | Command | What It Validates |
|------|---------|-------------------|
| /proc/self/exe resolves | `readlink /proc/self/exe` | Returns a real path (not "bash") |
| Different binaries differ | `bash -c "readlink ..."` vs `python3 -c "readlink ..."` | Different binaries see different /proc/self/exe |
| /proc/cpuinfo | `cat /proc/cpuinfo \| head -10` | CPU info accessible (needed by JVM, .NET GC) |
| /proc/meminfo | `cat /proc/meminfo \| head -5` | Memory info accessible (needed by JVM, .NET GC) |
| /proc/self/status | `cat /proc/self/status \| head -5` | Process status accessible |

#### Batch 2: Java /proc tests (single container)

| Test | Command | What It Validates |
|------|---------|-------------------|
| Java reads /proc/self/exe | Java program reads `/proc/self/exe` via `Files.readSymbolicLink` | JVM sees itself as "java", not "bash" |
| Java availableProcessors | Java program reads `Runtime.availableProcessors()` | JVM correctly reads /proc/cpuinfo for CPU count |

### Real-World Mapping

| Test | Real-World Scenario |
|------|-------------------|
| /proc/self/exe resolution | .NET CLR reads /proc/self/exe to find itself (required for startup). JVM reads it for identity. Rustup proxy reads it to determine which tool to invoke. |
| /proc/cpuinfo | JVM uses CPU count for thread pool sizing. .NET GC uses it for heap sizing. |
| /proc/meminfo | JVM and .NET use memory info for heap/GC configuration. |
| Different binary resolution | Ensures the procfs mount is truly dynamic (not cached from parent shell) |
| Java /proc/self/exe | Specific regression test - JVM was misidentifying itself as bash, causing startup issues |

### Gaps and Missing Coverage

1. **No .NET /proc/self/exe test** - .NET was the original motivation for the fix, but only Java has a /proc/self/exe verification test. A `dotnet` program reading /proc/self/exe would be valuable.

2. **No Rust/rustup /proc/self/exe test** - Rustup proxies use /proc/self/exe to determine which tool to invoke. No test verifies this.

3. **No /proc/self/environ test** - The one-shot-token security feature unsets sensitive tokens from `/proc/1/environ`. No test verifies tokens are actually cleared.

4. **No /proc/self/maps test** - Some runtimes read memory maps; not tested.

5. **No /proc isolation test** - The dynamic proc mount should be container-scoped (only container processes visible). No test verifies that host PIDs are NOT visible.

6. **No /proc/self/fd test** - File descriptor access via /proc is used by some tools; not tested.

7. **No Node.js /proc test** - Node.js uses /proc for certain operations (e.g., `process.memoryUsage()`, `os.cpus()`). No test verifies Node's /proc access.

8. **Soft failure pattern on Java tests** - Both Java /proc tests use `if (r.exitCode === 0)` guard, meaning they pass even if Java compilation fails.

---

## Cross-File Gap Analysis

### High-Priority Missing Tests

| Gap | Severity | Affected Scenarios |
|-----|----------|--------------------|
| **Credential hiding verification** | Critical | No test verifies `/dev/null` overlays on `~/.docker/config.json`, `~/.ssh/id_rsa`, etc. Prompt injection defense is untested. |
| **Signal handling (SIGTERM/SIGINT)** | High | No test for graceful shutdown and cleanup. Real AWF runs in CI with `timeout` which sends SIGTERM. |
| **DNS resolution in chroot** | High | Complex DNS setup (resolv.conf backup/restore, Docker embedded DNS) is completely untested. |
| **Package installation (pip/npm/cargo)** | High | Tests only query registries but never install packages. Real agents install packages constantly. |
| **`--env` passthrough** | Medium | Skipped test. Custom env vars are a core feature for passing API keys to agents. |
| **One-shot token protection** | Medium | `/proc/1/environ` token clearing is never tested. Security feature with no regression test. |
| **Bun runtime** | Medium | Explicitly supported in entrypoint.sh but never tested. |
| **Gradle build tool** | Medium | Proxy config pre-seeded by entrypoint.sh but never tested. |
| **`~/.claude.json` creation** | Medium | Created by entrypoint.sh for Claude Code API auth but never tested. |

### Test Pattern Issues

1. **Soft failure masking** - Many tests use `if (result.success)` or `if (r.exitCode === 0)` guards that silently pass on failure. While appropriate for CI flakiness, these should at minimum log a warning when the underlying check is skipped.

2. **No negative security tests** - Security features (capability drop, Docker socket hiding, credential hiding) lack comprehensive negative testing. Only NET_ADMIN and SYS_CHROOT drops are verified.

3. **No cleanup verification** - `entrypoint.sh` has extensive cleanup logic (resolv.conf restoration, hosts file cleanup, script file deletion). None of this is tested.

4. **Missing `--allow-full-filesystem-access` tests** - The escape hatch that mounts `/:/host:rw` instead of selective mounts is never tested.

5. **No `--mount` custom volume test** - Custom volume mounts passed via `--mount` flag are never tested in chroot context.

### Recommended Test Additions (Priority Order)

1. **Credential exfiltration test** - Verify `cat ~/.docker/config.json`, `cat ~/.ssh/id_rsa`, `cat ~/.config/gh/hosts.yml` all return empty or fail.
2. **Package install test** - `pip install requests`, `npm install chalk`, `cargo add serde` through the firewall.
3. **DNS resolution test** - `nslookup github.com` or `dig github.com` inside the chroot.
4. **Signal propagation test** - Send SIGTERM to AWF process, verify cleanup runs.
5. **`--env` passthrough test** - Pass custom env var, verify it's accessible in chroot.
6. **Token clearing test** - Verify `/proc/1/environ` doesn't contain sensitive tokens after agent starts.
7. **Bun runtime test** - `bun --version` and `bun run` inside chroot.
8. **Gradle proxy test** - Verify `~/.gradle/gradle.properties` contains proxy settings.
9. **`.claude.json` test** - Set `CLAUDE_CODE_API_KEY_HELPER`, verify file is created correctly.
10. **Home subdirectory write tests** - Verify `~/.cache`, `~/.config`, `~/.local` are writable.
