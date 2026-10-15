Thanks for helping make GitHub safe for everyone.

# Security

GitHub takes the security of our software products and services seriously, including all of the open source code repositories managed through our GitHub organizations, such as [GitHub](https://github.com/GitHub).

Even though [open source repositories are outside of the scope of our bug bounty program](https://bounty.github.com/index.html#scope) and therefore not eligible for bounty rewards, we will ensure that your finding gets passed along to the appropriate maintainers for remediation.

## Reporting Security Issues

If you believe you have found a security vulnerability in any GitHub-owned repository, please report it to us through coordinated disclosure.

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please send an email to opensource-security[@]github.com.

Please include as much of the information listed below as you can to help us better understand and resolve the issue:

- The type of issue (e.g., buffer overflow, SQL injection, or cross-site scripting)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

## Policy

See [GitHub's Safe Harbor Policy](https://docs.github.com/en/github/site-policy/github-bug-bounty-program-legal-safe-harbor#1-safe-harbor-terms)

## Deployment boundary

This service intentionally provides plain HTTP without authentication. It is designed for a
private network shared with a trusted API proxy, not for direct public exposure. The proxy owns
credentials, authorization, provider requests, and execution history.

Run the container without published ports, as a non-root user, with a read-only filesystem and
all capabilities dropped. Mount only trusted routing tables. See the
[container example](README.md#container) for the hardened invocation.

Request size and deadline limits are not a substitute for network isolation, connection limits,
or proxy timeouts. Context-window estimation is approximate. Frozen Python models do not make
nested containers deeply immutable, so in-process callers must not mutate shared routing data.

## Supported versions

This project is pre-release and has no published releases or long-term support branches.
Use the current `main` checkout and include its commit ID when reporting issues.