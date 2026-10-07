# AWF Examples

This directory contains example scripts demonstrating common ways to use the Agentic Workflow Firewall (`awf`).

## Prerequisites

- Docker running on your machine
- `awf` installed (see [installation instructions](../README.md#get-started-fast))
- `sudo` access (required for iptables manipulation)

## Examples

| File | Description |
|------|-------------|
| [basic-curl.sh](basic-curl.sh) | Simple HTTP request through the firewall |
| [github-copilot.sh](github-copilot.sh) | Using GitHub Copilot CLI with the firewall |
| [using-domains-file.sh](using-domains-file.sh) | Using a file to specify allowed domains |
| [blocked-domains.sh](blocked-domains.sh) | Blocking specific domains with allowlist/blocklist |
| [debugging.sh](debugging.sh) | Debug mode with log inspection |
| [domains.txt](domains.txt) | Example domain allowlist file |
| [enclave-environment-probe](enclave-environment-probe/README.md) | Bounded public-sensitivity Cloud Hypervisor script-enclave metadata probe |

## Running Examples

The shell examples are standalone scripts. The enclave probe has its own
[supported broker invocation instructions](enclave-environment-probe/README.md#supported-invocation).
Run shell examples with:

```bash
# Make executable (if needed)
chmod +x examples/*.sh

# Run an example
./examples/basic-curl.sh
```

> **Note:** Most examples require `sudo` for iptables manipulation. The scripts will prompt for sudo access if needed.

## Domain Matching

AWF automatically matches subdomains. For example:
- `github.com` matches `github.com`, `api.github.com`, `raw.githubusercontent.com`, etc.

See [domains.txt](domains.txt) for domain file format examples.
