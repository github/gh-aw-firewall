# Docker Image Verification

All published Docker images are signed with [cosign](https://github.com/sigstore/cosign) using keyless signing. You can verify the signatures to ensure image authenticity and integrity.

## Installing Cosign

### Package Managers (Recommended)

```bash
# Homebrew (macOS/Linux)
brew install cosign

# Debian/Ubuntu
sudo apt update && sudo apt install -y cosign
```

See the [official installation guide](https://docs.sigstore.dev/cosign/installation/) for all installation options.

### Direct Download

```bash
# Quick install for testing (verify checksums from GitHub release page for production)
curl -sSfL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o cosign
chmod +x cosign
sudo mv cosign /usr/local/bin/
```

## Verifying Image Signatures

All images are signed using GitHub Actions OIDC tokens, ensuring they come from the official repository.

### Verify Squid Image

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/github/gh-aw-firewall/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/github/gh-aw-firewall/squid:latest
```

### Verify Agent Image

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/github/gh-aw-firewall/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/github/gh-aw-firewall/agent:latest
```

## Verifying SBOM Attestations

Images include Software Bill of Materials (SBOM) attestations for supply chain transparency.

```bash
cosign verify-attestation \
  --certificate-identity-regexp 'https://github.com/github/gh-aw-firewall/.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --type spdxjson \
  ghcr.io/github/gh-aw-firewall/squid:latest
```

## What Gets Signed

- **Image Signatures**: Cryptographic signatures proving the image was built by the official GitHub Actions workflow
- **SBOM Attestations**: Software Bill of Materials in SPDX JSON format, listing all dependencies and components
- **Transparency Log**: All signatures are recorded in Sigstore's Rekor transparency log

## Security Benefits

- **Image Authenticity**: Verify images come from the official repository
- **Supply Chain Security**: SBOM attestations provide transparency about image contents
- **Keyless Signing**: Uses GitHub Actions OIDC tokens (no secret keys to manage)
- **Reproducible Builds**: GitHub Actions pinned to commit hashes prevent supply chain attacks

## SSHHole (CVE-2026-123158) Applicability

Assessed on 2026-11-12 against the published
[v0.29.12 release](https://github.com/github/gh-aw-firewall/releases/tag/v0.29.12).
The inspected Alpine images do **not** contain OpenSSH or an SSH daemon, so
there is no OpenSSH package to patch in these images for this CVE.
This is an applicability assessment, not a claim that a patch was deployed.

The [OpenSSH 10.6p2 release notes](https://www.openssh.org/releasenotes.html#10.6p2)
describe a password-authentication bypass in `sshd` on musl-based Linux when PAM
is disabled. The
[Alpine advisory](https://alpinelinux.org/posts/2026-11-05-openssh-password-authentication-bypass/)
explicitly excludes containers that do not run `sshd`. An SSH client version
alone does not establish exposure. Other prerequisites include password
authentication, an eligible account whose password field is `*`, and another
local account with a `$5$` or `$6$` password hash.

### Published Image Evidence

The following results come from registry image layers, not just Dockerfile
package lists or `ssh -V`. Both `linux/amd64` and `linux/arm64` variants were
inspected for every row. The final `/lib/apk/db/installed` database contained no
`openssh*` package entries, and the layers contained no files named `sshd`,
`sshd-session`, or `sshd-auth`.

| Image | `/etc/alpine-release` | Installed musl revision | OpenSSH packages / SSH daemon |
|-------|-----------------------|-------------------------|------------------------------|
| `squid` | `3.24.2` | `1.2.6-r2` | Absent |
| `api-proxy` | `3.24.4` | `1.2.6-r3` | Absent |
| `cli-proxy` | `3.24.4` | `1.2.6-r3` | Absent |
| `gh-aw-node` | `3.24.4` | `1.2.6-r3` | Absent |
| `enclave-script` | `3.24.4` | `1.2.6-r3` | Absent |
| `enclave-mcp-server` | `3.24.4` | `1.2.6-r3` | Absent |

The published `router` image was also inspected on both architectures: it has
no APK package database or SSH daemon files. The reviewed agent, agent-act,
build-tools, enclave-agent, and Cloud Hypervisor Dockerfile bases use glibc
rather than the affected musl authentication path.

The inspected multi-architecture image digests match the release's
[`containers.txt`](https://github.com/github/gh-aw-firewall/releases/download/v0.29.12/containers.txt):

```text
ghcr.io/github/gh-aw-firewall/squid@sha256:237d2552ee6f0689f00909d98a462437bd109a1ee4d75acb23de11bf8d96c337
ghcr.io/github/gh-aw-firewall/api-proxy@sha256:78d572496cae034e1f48f28e000aad2a91e284197716ee0c7cf8f92c939d01af
ghcr.io/github/gh-aw-firewall/cli-proxy@sha256:c35f126cd3ac81f0c40f17d240fff0d1349908f6406bc7fd2cd424b01de52aff
ghcr.io/github/gh-aw-firewall/gh-aw-node@sha256:23af4cb600abd3e7c7d3cc45b24ff1685dae7ff8aad3960e57fe18e6ce9b843c
ghcr.io/github/gh-aw-firewall/enclave-script@sha256:d8d664327df40daddb484e30d7d7c45f0292bfd2bc7dcc73ef221d1dba931a1e
ghcr.io/github/gh-aw-firewall/enclave-mcp-server@sha256:a1dbd92e222de93f7d63592f98d53bccf20edd04d1bcaa6868444d1652b9fdff
ghcr.io/github/gh-aw-firewall/router@sha256:3933f43c8e153e3ff6cb2a1d98068ea9f79173f2faf1b3ab380559439a6d8d6d
```

### Scope and Remediation

This assessment does not cover every older release, host-installed SSH servers,
user-supplied agent images, or containers modified after startup. Final package
inventories of the glibc-based images and VM rootfs artifacts were not inspected
for this assessment. The local Docker daemon was unavailable, so no containers
were started, rebuilt, or runtime-tested. Registry filesystem inspection does
not attest to the state of a running deployment.

If adding or operating an Alpine SSH server, follow Alpine's branch-specific
fixed package revisions rather than comparing only the upstream version.
For Alpine 3.24 the fixed OpenSSH revision is `10.3_p1-r2`; other branches have
different backports. Upgrade the affected server package and **restart `sshd`**.
If an upgrade is not yet possible, disable effective `PasswordAuthentication`
(including applicable `Match` overrides) and restart the daemon. Do not install
an SSH server into an otherwise unaffected image merely to satisfy a version
check.
