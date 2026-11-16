Thanks for helping make GitHub safe for everyone.

# Security

## Host runtime IPC boundary

AWF must not expose the runner's default temporary-directory IPC to the agent.
The Docker and gVisor Compose agent use **private, writable tmpfs filesystems**
at `/tmp` and `/host/tmp`, with mode `1777`. Host `/tmp` is not bind-mounted.
This keeps host CoreCLR debugger FIFOs (`clr-debug-pipe-*`) and diagnostic
sockets (`dotnet-diagnostic-*`) outside the sandbox, including endpoints created
**after** the agent starts. The sbx backend likewise shares `/tmp/gh-aw`, not the
host temporary root; its guest supplies its own `/tmp`.

The shared exceptions are the `/tmp/gh-aw` handoff, explicitly configured mounts,
the workspace, selected home tool directories, staged runner binaries, and the
init-signal/log/session paths. Choosing `/tmp` as the container working directory
does not restore host `/tmp` sharing. Other host temporary files are no longer
implicitly available: stage inputs in a dedicated directory and mount only that
directory, for example `--mount /tmp/my-inputs:/inputs:ro`.

Before launching the command, the Compose agent entrypoint checks the actual
container filesystem view under `/tmp`, `/host/tmp`, and absolute `$TMPDIR`,
`$HOME`, and `$RUNNER_TEMP` paths (including their `/host` views). It refuses to
launch if any CoreCLR endpoint name is visible or a directory cannot be
inspected. It does not unlink endpoints, change host process settings, or read
runner memory. This also checks the daemon-visible paths on ARC/DinD rather
than assuming the runner and daemon have the same filesystem.

**This is not a blanket guarantee against IPC placed in intentionally shared
directories.** The workspace, allowlisted home subdirectories, `/tmp/gh-aw`,
and custom mounts are live host shares. Do not run privileged or
credential-holding host services with IPC in them, or mount an IPC directory
through another path. A startup check cannot prevent endpoints created later
inside these shares, and does not inspect arbitrary custom destination aliases.
Read-only binds, owner-only permissions (the agent may have the runner UID),
PID/IPC namespaces, and `--exclude-env` do not prevent communication with a
visible host pathname socket or FIFO. Workflows requiring that stronger boundary
must avoid such live shares or use an independently isolated execution identity
and filesystem. Enabling Docker socket access also grants authority outside this
boundary.

The in-container check requires an updated agent image, not just an updated CLI;
older pinned images do not contain it. These mount and entrypoint guarantees are
for Compose; sbx has the narrowed default share but not this entrypoint check.
Cloud Hypervisor and NVX have separate guest/export policies, not the Compose
mount tree. See the [filesystem sharing contract](filesystem-sharing-contract.md).
Host-side endpoint removal may remain as defense in depth but is not the
mechanism protecting private `/tmp`.

## Security reporting

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
