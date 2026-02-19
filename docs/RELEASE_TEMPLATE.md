# Release Notes Template

This file is used to generate release notes automatically during the release workflow.
Edit this file to change the format of release notes for all future releases.

## Available Placeholders

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{CHANGELOG}}` | Auto-generated changelog from GitHub API or git log | PR list or commit list |
| `{{CLI_HELP}}` | Output of `awf --help` command | CLI usage and options |
| `{{REPOSITORY}}` | GitHub repository path | `github/gh-aw-firewall` |
| `{{VERSION}}` | Full version tag with 'v' prefix | `v0.3.0` |
| `{{VERSION_NUMBER}}` | Version number without 'v' prefix | `0.3.0` |

## Template Content

Everything below the `---` separator becomes the release notes.

---

{{CHANGELOG}}

## CLI Options

```
{{CLI_HELP}}
```

## Installation

### One-Line Installer (Recommended)

**Linux (x64 and ARM64) with automatic SHA verification:**
```bash
curl -sSL https://raw.githubusercontent.com/{{REPOSITORY}}/main/install.sh | sudo bash
```

This installer:
- Automatically detects your architecture (x86_64 or aarch64)
- Downloads the correct release binary
- Verifies SHA256 checksum against `checksums.txt`
- Validates the file is a valid ELF executable
- Installs to `/usr/local/bin/awf`

### Manual Binary Installation (Alternative)

**Linux (x64):**
```bash
# Download binary and checksums
curl -fL https://github.com/{{REPOSITORY}}/releases/download/{{VERSION}}/awf-linux-x64 -o awf
curl -fL https://github.com/{{REPOSITORY}}/releases/download/{{VERSION}}/checksums.txt -o checksums.txt

# Verify checksum
sha256sum -c checksums.txt --ignore-missing

# Install
chmod +x awf
sudo mv awf /usr/local/bin/
```

**Linux (ARM64):**
```bash
# Download binary and checksums
curl -fL https://github.com/{{REPOSITORY}}/releases/download/{{VERSION}}/awf-linux-arm64 -o awf
curl -fL https://github.com/{{REPOSITORY}}/releases/download/{{VERSION}}/checksums.txt -o checksums.txt

# Verify checksum
sha256sum -c checksums.txt --ignore-missing

# Install
chmod +x awf
sudo mv awf /usr/local/bin/
```

### NPM Installation (Alternative)

```bash
# Install from tarball
npm install -g https://github.com/{{REPOSITORY}}/releases/download/{{VERSION}}/awf.tgz
```

## Quick Start

```bash
# Basic usage with domain whitelist
sudo awf --allow-domains github.com,api.github.com -- curl https://api.github.com

# Pass environment variables
sudo awf --allow-domains api.github.com -e GITHUB_TOKEN=xxx -- gh api /user

# Mount additional volumes
sudo awf --allow-domains github.com -v /my/data:/data:ro -- cat /data/file.txt

# Set working directory in container
sudo awf --allow-domains github.com --container-workdir /workspace -- pwd
```

See [README.md](https://github.com/{{REPOSITORY}}/blob/{{VERSION}}/README.md) for full documentation.

## Container Images

Published to GitHub Container Registry:
- `ghcr.io/{{REPOSITORY}}/squid:{{VERSION_NUMBER}}`
- `ghcr.io/{{REPOSITORY}}/agent:{{VERSION_NUMBER}}`
- `ghcr.io/{{REPOSITORY}}/squid:latest`
- `ghcr.io/{{REPOSITORY}}/agent:latest`

### Image Verification

All container images are cryptographically signed with [cosign](https://github.com/sigstore/cosign) for authenticity verification.

```bash
# Verify image signature
cosign verify \
  --certificate-identity-regexp 'https://github.com/{{REPOSITORY}}/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/{{REPOSITORY}}/squid:{{VERSION_NUMBER}}
```

For detailed instructions including SBOM verification, see [docs/image-verification.md](https://github.com/{{REPOSITORY}}/blob/{{VERSION}}/docs/image-verification.md).
