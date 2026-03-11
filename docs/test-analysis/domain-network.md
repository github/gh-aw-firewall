# Domain & Network Integration Test Analysis

> Generated 2026-02-25. Covers 6 test files in `tests/integration/` related to domain filtering, wildcard patterns, network security, DNS, and localhost access.

---

## Table of Contents

1. [blocked-domains.test.ts](#1-blocked-domainstestts)
2. [wildcard-patterns.test.ts](#2-wildcard-patternstestts)
3. [empty-domains.test.ts](#3-empty-domainstestts)
4. [network-security.test.ts](#4-network-securitytestts)
5. [dns-servers.test.ts](#5-dns-serverstestts)
6. [localhost-access.test.ts](#6-localhost-accesstestts)
7. [Cross-Cutting Gaps](#7-cross-cutting-gaps)

---

## 1. blocked-domains.test.ts

**File:** `tests/integration/blocked-domains.test.ts` (185 lines, 9 tests)

### What It Tests

| # | Test | Description |
|---|------|-------------|
| 1 | `should block specific domain even when parent is allowed` | Allows `github.com`, accesses `api.github.com` — verifies subdomain auto-inclusion (expects success, not actually testing block) |
| 2 | `should allow requests to allowed domains` | Simple allow-list test: `github.com` allows `api.github.com/zen` |
| 3 | `should block requests to non-allowed domains` | With only `github.com` allowed, `example.com` is blocked (expects `toFail`) |
| 4 | `should handle multiple blocked domains` | Two domains in allow-list (`github.com`, `npmjs.org`), verifies `api.github.com` succeeds |
| 5 | `should show allowed domains in debug output` | Verifies `[INFO] Allowed domains:` appears in stderr with `--log-level debug` |
| 6 | `should handle case-insensitive domain matching` | Accesses `https://API.GITHUB.COM/zen` with `github.com` in allow-list — DNS/Squid are case-insensitive |
| 7 | `should handle domains with trailing dots` | Allows `github.com.` (FQDN trailing dot) — verifies normalization handles it |
| 8 | `should handle domains with leading/trailing whitespace` | Allows `  github.com  ` — verifies `parseDomains()` trims whitespace |
| 9 | `should block IP address access when only domain is allowed` | Resolves `api.github.com` to IP, curls the raw IP — expects block |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1-2 | When Claude/Copilot agents access `api.github.com` with `github.com` whitelisted — the most common AWF configuration |
| #3 | When a malicious prompt causes an agent to access a non-whitelisted domain (e.g., exfiltrating code to attacker domain) |
| #4 | Multi-service workflow: agent needs GitHub API + npm registry |
| #6-8 | Robustness against variant domain representations in agent HTTP clients (Node.js fetch, Python requests, curl) |
| #9 | SSRF mitigation: agent resolves domain to IP and curls IP directly to bypass domain filtering |

### Gaps and Missing Coverage

1. **No actual `--block-domains` flag testing**: Despite the file name, no test uses the `--block-domains` CLI option. All tests use `--allow-domains` only. The `blockedDomains` field in `AwfRunner` options isn't even defined.
2. **No block-overrides-allow precedence test**: The Squid config places blocked domain ACLs before allowed domain ACLs. No test verifies that `--block-domains internal.corp.com --allow-domains corp.com` actually blocks `internal.corp.com`.
3. **No `--block-domains-file` test**: File-based blocklist parsing is untested in integration.
4. **No `--allow-domains-file` test**: File-based allowlist parsing is untested in integration (only unit-tested in `cli.test.ts`).
5. **Test #1 is misleading**: Named "should block specific domain even when parent is allowed" but doesn't actually test blocking — it just tests subdomain inclusion. The test name suggests `--block-domains` functionality.
6. **No test for blocking a subdomain while allowing parent**: e.g., `--allow-domains github.com --block-domains api.github.com` then verify `api.github.com` is blocked but `github.com` works.

### Edge Cases Missing

- Domain with port number (e.g., `example.com:8080`)
- Punycode / internationalized domain names (e.g., `xn--nxasmq6b.example.com`)
- Domain that is a prefix of an allowed domain (e.g., allow `github.com`, test `github.com.evil.com` — should be blocked)
- Multiple consecutive requests to different domains in the same container session
- Very long domain names (close to 253 char RFC limit)

---

## 2. wildcard-patterns.test.ts

**File:** `tests/integration/wildcard-patterns.test.ts` (185 lines, 11 tests)

### What It Tests

| # | Test | Describe Block | Description |
|---|------|----------------|-------------|
| 1 | `should allow subdomain with *.github.com pattern` | Leading Wildcard | `*.github.com` allows `api.github.com` |
| 2 | `should allow raw.githubusercontent.com` | Leading Wildcard | `*.githubusercontent.com` + `github.com` allows `raw.githubusercontent.com` |
| 3 | `should allow nested subdomains` | Leading Wildcard | `*.github.com` allows `api.github.com` (duplicate of #1) |
| 4 | `should match domain case-insensitively` | Case Insensitivity | `github.com` allows `API.GITHUB.COM` |
| 5 | `should match wildcard pattern case-insensitively` | Case Insensitivity | `*.GitHub.COM` allows `API.GITHUB.COM` |
| 6 | `should allow exact domain match` | Plain Domain | `github.com` allows `github.com/robots.txt` |
| 7 | `should allow subdomains of plain domain` | Plain Domain | `github.com` implicitly allows `api.github.com` |
| 8 | `should allow domains matching any of multiple patterns` | Multiple Patterns | Three wildcard patterns, one domain tested |
| 9 | `should combine wildcard and plain domain patterns` | Multiple Patterns | Mixed wildcard + plain domain list |
| 10 | `should block domain not matching any pattern` | Non-Matching | `*.github.com` blocks `example.com` |
| 11 | `should block similar-looking domain` | Non-Matching | `*.github.com` blocks `notgithub.com` (suffix attack) |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1-3 | Agent accessing GitHub API, raw file downloads — extremely common in agentic workflows |
| #2 | When Claude downloads raw files from GitHub repos for code review |
| #4-5 | HTTP client libraries may normalize case differently — ensures consistent behavior |
| #6-7 | Core domain filtering: `github.com` in frontmatter allows all GitHub subdomains |
| #8-9 | Complex workflows needing multiple code hosting platforms (GitHub + GitLab + Bitbucket) |
| #10-11 | Security: preventing domain confusion attacks where `notgithub.com` could be attacker-controlled |

### Gaps and Missing Coverage

1. **No mid-domain wildcard test**: `api-*.example.com` pattern is mentioned in `domain-patterns.ts` docs but never tested in integration. This pattern is supported by the `wildcardToRegex()` function.
2. **No deeply nested subdomain test**: e.g., `*.github.com` should match `a.b.c.github.com`. The regex `[a-zA-Z0-9.-]*` allows dots, so this should work, but it's untested.
3. **No bare wildcard exclusion test**: `*.github.com` should NOT match `github.com` itself (only subdomains). This is a critical semantic difference that's untested.
4. **Test #3 is a duplicate of #1**: Both test `*.github.com` allowing `api.github.com`.
5. **No protocol-specific wildcard test**: e.g., `https://*.github.com` — the domain-patterns module supports this but it's not integration-tested.
6. **No test for multiple wildcards matching the same domain**: e.g., both `*.github.com` and `*.com` — verifies no regex conflict.

### Edge Cases Missing

- Wildcard with only TLD: `*.com` (should this be rejected as too broad? Currently `validateDomainOrPattern` doesn't explicitly reject it)
- Trailing dot with wildcard: `*.github.com.`
- Empty subdomain match: does `*.github.com` match `.github.com`?
- Wildcard pattern that overlaps with a plain domain in the allow-list

---

## 3. empty-domains.test.ts

**File:** `tests/integration/empty-domains.test.ts` (149 lines, 8 tests)

### What It Tests

| # | Test | Describe Block | Description |
|---|------|----------------|-------------|
| 1 | `should block all network access when no domains are specified` | Network Blocking | `allowDomains: []` blocks `https://example.com` |
| 2 | `should block HTTPS traffic` | Network Blocking | Empty allow-list blocks `https://api.github.com` |
| 3 | `should block HTTP traffic` | Network Blocking | Empty allow-list blocks `http://httpbin.org` |
| 4 | `should allow commands that do not require network` | Offline Commands | `echo "Hello"` works with empty allow-list |
| 5 | `should allow file system operations` | Offline Commands | File create/read/delete works without network |
| 6 | `should allow local computations` | Offline Commands | `expr 2 + 2` works without network |
| 7 | `should indicate no domains in debug output` | Debug Output | Stderr matches `No allowed domains specified` or `all network access will be blocked` |
| 8 | `should block network even when DNS resolution succeeds` | DNS Behavior | DNS resolves but HTTP connection still blocked |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1-3 | "Air-gapped" agent mode: running code analysis or refactoring that needs zero network access. This is the safest mode for untrusted code. |
| #4-6 | Agent performs local-only tasks (file editing, computation) inside the sandbox — must work even with all network blocked |
| #7 | Operator debugging: seeing confirmation that no domains are configured |
| #8 | Defense-in-depth: even if DNS leaks (which it does — DNS is allowed through), the HTTP/HTTPS layer still blocks connections |

### Gaps and Missing Coverage

1. **No test for DNS exfiltration**: DNS queries are allowed even with empty domains. An attacker could encode data in DNS queries to exfiltrate secrets. There's no test for DNS-based data exfiltration (though `--dns-servers` limits which DNS servers are reachable).
2. **No test for non-HTTP protocols**: What about SSH (port 22), SMTP (port 25), or raw TCP? These should be blocked by iptables rules, but aren't tested in this file.
3. **No test for localhost access with empty domains**: Can the agent connect to `127.0.0.1` services with empty domains?
4. **No test for the `--allow-domains` flag being completely omitted** (vs. passed as empty): The CLI behavior may differ.

### Edge Cases Missing

- UDP traffic (e.g., DNS-over-UDP to a custom server on a non-standard port)
- ICMP/ping with empty domains
- Agent trying to curl localhost or 127.0.0.1 with empty domains

---

## 4. network-security.test.ts

**File:** `tests/integration/network-security.test.ts` (232 lines, 14 tests)

### What It Tests

| # | Test | Describe Block | Description |
|---|------|----------------|-------------|
| 1 | `should drop NET_ADMIN after iptables setup` | Capability Restrictions | `iptables -t nat -L OUTPUT` fails inside container |
| 2 | `should block iptables flush attempt` | Capability Restrictions | `iptables -t nat -F OUTPUT` fails (can't flush NAT rules) |
| 3 | `should block iptables delete attempt` | Capability Restrictions | `iptables -t nat -D OUTPUT 1` fails (can't delete rules) |
| 4 | `should block iptables insert attempt` | Capability Restrictions | `iptables -t nat -I OUTPUT -j ACCEPT` fails (can't add ACCEPT rule) |
| 5 | `should block curl --connect-to bypass` | Firewall Bypass | `curl --connect-to ::github.com: https://example.com` — tries to resolve `example.com` via `github.com` IP |
| 6 | `should block NO_PROXY bypass` | Firewall Bypass | `NO_PROXY='*'` doesn't bypass the firewall (because firewall uses iptables, not env vars) |
| 7 | `should block ALL_PROXY bypass` | Firewall Bypass | `ALL_PROXY=''` doesn't bypass the firewall |
| 8 | `should block AWS metadata endpoint` | SSRF Protection | `169.254.169.254` is blocked |
| 9 | `should block AWS metadata with path` | SSRF Protection | `169.254.169.254/latest/meta-data/` is blocked |
| 10 | `should block GCP metadata endpoint` | SSRF Protection | `metadata.google.internal` with GCP header is blocked |
| 11 | `should block Azure metadata endpoint` | SSRF Protection | `169.254.169.254/metadata/instance` with Azure header is blocked |
| 12 | `should block DNS over HTTPS (DoH)` | DNS Security | `cloudflare-dns.com/dns-query` is blocked |
| 13 | `should block Google DoH endpoint` | DNS Security | `dns.google/dns-query` is blocked |
| 14 | `should maintain firewall after bypass attempt` | Effectiveness | Attempts `iptables flush` then `curl example.com` — both fail |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1-4 | **Critical security**: Malicious prompt injection causes agent to try modifying iptables rules to disable the firewall. The `capsh --drop=cap_net_admin` in `entrypoint.sh` prevents this. |
| #5 | Sophisticated bypass: agent uses `curl --connect-to` to route blocked domain through allowed domain's IP |
| #6-7 | Agent sets proxy-bypass env vars hoping to avoid Squid. AWF uses iptables DNAT (L3), not proxy env vars, so this doesn't work. |
| #8-11 | **SSRF protection**: Agent on cloud infrastructure (AWS/GCP/Azure) tries to access instance metadata to steal credentials. This is a top OWASP risk. |
| #12-13 | Agent tries DNS-over-HTTPS to exfiltrate data or resolve blocked domains via an encrypted channel |
| #14 | Compound attack: first try to disable firewall, then access blocked domain |

### Gaps and Missing Coverage

1. **No test for `http_proxy`/`https_proxy` override**: Agent could set `http_proxy=direct://` or `https_proxy=` to try bypassing. While AWF uses iptables DNAT, this should still be tested.
2. **No test for iptables -A (append) bypass**: Tests cover `-F` (flush), `-D` (delete), `-I` (insert), but not `-A` (append).
3. **No test for `ip route` manipulation**: Agent might try to add a route to bypass Squid. Should be blocked by dropped NET_ADMIN.
4. **No test for `nsenter` or container escape**: Agent in container tries to escape to host namespace.
5. **No test for SSRF via DNS rebinding**: Agent resolves allowed domain that DNS-rebinds to internal IP (e.g., `169.254.169.254`).
6. **No test for SSRF via redirect**: Agent accesses allowed domain that returns HTTP 302 redirect to `http://169.254.169.254`.
7. **No `169.254.0.0/16` link-local range test**: Only `169.254.169.254` (metadata) is tested — but other link-local IPs could be dangerous.
8. **No test for IMDSv2 (token-based)**: AWS IMDSv2 uses PUT to get a token first, then GET metadata. Only IMDSv1-style requests are tested.
9. **No test for internal Docker network access**: Can agent reach `172.30.0.10` (Squid) or `172.30.0.1` (gateway) directly?

### Edge Cases Missing

- `curl --resolve` bypass (similar to `--connect-to`)
- Agent using `socat` or `nc` for raw TCP connections
- Agent trying to use container's Docker socket if mounted
- Agent trying to use IPv6 link-local addresses
- Agent modifying `/etc/resolv.conf` to point to a malicious DNS server

---

## 5. dns-servers.test.ts

**File:** `tests/integration/dns-servers.test.ts` (115 lines, 6 tests)

### What It Tests

| # | Test | Description |
|---|------|-------------|
| 1 | `should resolve DNS with default servers` | `nslookup github.com` works with default DNS (8.8.8.8, 8.8.4.4) |
| 2 | `should resolve DNS with custom Google DNS` | `nslookup github.com 8.8.8.8` works explicitly |
| 3 | `should resolve DNS with Cloudflare DNS` | `nslookup github.com 1.1.1.1` works |
| 4 | `should show DNS servers in debug output` | stderr contains `DNS` or `dns` |
| 5 | `should resolve multiple domains sequentially` | `nslookup github.com && nslookup api.github.com` both succeed |
| 6 | `should resolve DNS for allowed domains` | `dig github.com +short` returns IP addresses |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1 | Default configuration: agent resolves GitHub API before making requests |
| #2-3 | Organization mandates specific DNS servers (corporate DNS policy, Cloudflare for privacy) |
| #5 | Agent resolves multiple APIs during a workflow (GitHub + npm + PyPI) |
| #6 | Verifying DNS resolution actually returns IPs (not NXDOMAIN or empty) |

### Gaps and Missing Coverage

1. **No `--dns-servers` CLI option test**: None of these tests actually use the `--dns-servers` flag. They all use default DNS. The `dnsServers` option exists in `AwfRunner` but is never passed.
2. **No DNS restriction test**: With `--dns-servers 8.8.8.8`, can the agent still query `1.1.1.1`? The iptables rules should block non-whitelisted DNS servers, but this is untested.
3. **No IPv6 DNS server test**: `isValidIPv6()` exists in the CLI, but no integration test uses IPv6 DNS.
4. **No invalid DNS server test**: What happens with `--dns-servers 999.999.999.999`? The CLI validates, but no integration test covers this path.
5. **No DNS resolution of blocked domains test**: Can the agent resolve a domain that's NOT in the allow-list? (DNS resolution should succeed per design, but HTTP access should be blocked.)
6. **No DNS timeout/failure test**: What happens when DNS servers are unreachable?

### Edge Cases Missing

- DNS resolution for non-existent domains (NXDOMAIN)
- DNS resolution for domains with CNAME chains
- DNS resolution with `--dns-servers 127.0.0.1` (using container-local DNS)
- Agent trying to use `dig @attacker-dns.com` with a non-whitelisted DNS server

---

## 6. localhost-access.test.ts

**File:** `tests/integration/localhost-access.test.ts` (138 lines, 8 tests)

### What It Tests

| # | Test | Description |
|---|------|-------------|
| 1 | `should automatically enable host access when localhost is in allowed domains` | `allowDomains: ['localhost']` triggers security warning, auto-enables host access, auto-allows common dev ports |
| 2 | `should map localhost to host.docker.internal` | `localhost` in allow-list becomes `host.docker.internal` in config |
| 3 | `should preserve http:// protocol prefix` | `http://localhost` becomes `http://host.docker.internal` |
| 4 | `should preserve https:// protocol prefix` | `https://localhost` becomes `https://host.docker.internal` |
| 5 | `should work with localhost combined with other domains` | `['localhost', 'github.com', 'example.com']` — all domains present, localhost mapped |
| 6 | `should allow custom port range to override default` | `allowHostPorts: '8080'` overrides default port list (no "allowing common development ports" message) |
| 7 | `should resolve host.docker.internal from inside container` | `getent hosts host.docker.internal` returns an IP |
| 8 | `should work for Playwright-style testing scenario` | Simulates Playwright test context (just echo commands, no actual server) |

### Real-World Mapping

| Test | Real-World Scenario |
|------|---------------------|
| #1-2 | **Playwright testing**: Agent runs Playwright tests against a local dev server (e.g., `localhost:3000`). AWF maps `localhost` to `host.docker.internal` so container can reach host services. |
| #3-4 | Protocol-specific access: agent needs HTTP-only or HTTPS-only to localhost |
| #5 | Agent needs both localhost (for dev server) and external domains (for API calls) |
| #6 | Custom dev server on non-standard port (e.g., `8080` for Spring Boot) |
| #7 | Container DNS resolution: `host.docker.internal` must resolve to the Docker host IP |
| #8 | End-to-end Playwright-style usage (though mocked — no actual HTTP server) |

### Gaps and Missing Coverage

1. **No actual HTTP request to localhost**: No test starts a server on the host and verifies the agent can reach it. Test #8 is just echo commands.
2. **No test for port filtering**: Do the auto-allowed ports (3000, 4200, 5173, 8080, etc.) actually work? Is port 22 (SSH) blocked?
3. **No test for dangerous port blocking**: `squid-config.ts` defines `DANGEROUS_PORTS` (22, 3306, 5432, 6379, etc.) that should be blocked even with `--allow-host-ports`. No integration test verifies this.
4. **No test for `--enable-host-access` without `localhost` keyword**: The flag can be set directly without using the `localhost` keyword.
5. **No test for multiple localhost entries**: e.g., `['localhost', 'http://localhost']` — how is this handled?
6. **No test for `localhost:PORT` format**: Users might try `localhost:3000` as a domain.

### Edge Cases Missing

- Agent trying to access host Docker socket via `host.docker.internal`
- Agent accessing host-bound services on non-standard interfaces (e.g., `0.0.0.0` vs `127.0.0.1`)
- Port range specification (e.g., `3000-4000`)
- Localhost with IPv6 (`::1`)

---

## 7. Cross-Cutting Gaps

### Infrastructure Issues

1. **No `--block-domains` support in `AwfRunner`**: The test runner (`awf-runner.ts`) doesn't have a `blockDomains` option, making it impossible to test the blocklist feature in integration tests without modifying the runner.

2. **No protocol-specific integration tests**: The `domain-patterns.ts` module supports `http://`, `https://` prefixes on domains, and `squid-config.ts` generates protocol-specific ACLs (`allowed_http_only`, `allowed_https_only`). None of this is integration-tested.

3. **No SSL Bump integration tests**: The `--ssl-bump` feature generates entirely different Squid config (with CA certs, `ssl_bump peek/stare/bump`). No integration test covers this.

4. **No `--allow-urls` integration tests**: URL-level filtering (requires `--ssl-bump`) is untested in integration.

### Security Scenarios Not Covered

| Scenario | Risk | Current Coverage |
|----------|------|-----------------|
| DNS rebinding attack | Agent resolves allowed domain -> attacker DNS returns internal IP | None |
| HTTP redirect to internal | Allowed domain returns 302 to `169.254.169.254` | None |
| Domain fronting | Agent uses TLS SNI of allowed domain but HTTP Host header of blocked domain | None |
| Slowloris / connection exhaustion | Agent opens many connections to exhaust Squid resources | None |
| Data exfiltration via DNS | Encode secrets in DNS query labels | None |
| Agent modifying proxy config | Agent writes to `/etc/environment` or `/etc/profile.d/` | None |
| Time-of-check/time-of-use | Domain resolves to allowed IP during check, then changes | None |

### Recommended New Test Files

1. **`block-domains.test.ts`** — Dedicated tests for `--block-domains` and `--block-domains-file` functionality
2. **`protocol-filtering.test.ts`** — Tests for `http://` and `https://` protocol-specific domain filtering
3. **`host-access.test.ts`** — Tests for `--enable-host-access` with an actual HTTP server on the host, port filtering, dangerous port blocking
4. **`ssl-bump.test.ts`** — Tests for SSL Bump mode with URL-level filtering
5. **`dns-restriction.test.ts`** — Tests for `--dns-servers` actually restricting which DNS servers the agent can query
