# Release Process

This document describes how to create a new release of the agentic-workflow-firewall (awf).

## Prerequisites

- Ability to trigger workflows (Actions tab or `gh` CLI)

## Release Steps

### 1. Run the Release Workflow

From the CLI:

```bash
# Patch release (0.1.0 -> 0.1.1)
gh workflow run release.yml -f bump=patch

# Minor release (0.1.1 -> 0.2.0)
gh workflow run release.yml -f bump=minor

# Major release (0.2.0 -> 1.0.0)
gh workflow run release.yml -f bump=major
```

Or from the GitHub UI: go to **Actions** > **Release** > **Run workflow**, select the bump type, and click **Run workflow**.

The workflow will:
- Bump the version in `package.json`
- Commit the version change and create a git tag
- Build and push Docker images to GHCR
- Create Linux x64 and arm64 binaries
- Create NPM tarball and checksums
- Publish the GitHub Release with auto-generated changelog

### 2. Verify Release

Once the workflow completes:

1. Go to **Releases** page
2. Verify the new release is published with:
   - Linux x64 binary (`awf-linux-x64`)
   - Linux arm64 binary (`awf-linux-arm64`)
   - NPM tarball (`awf.tgz`)
   - Checksums file (`checksums.txt`)
   - Installation instructions with GHCR image references
3. Go to **Packages** page (in repository)
4. Verify Docker images are published:
   - `squid:<version>` and `squid:latest`
   - `agent:<version>` and `agent:latest`
   - `api-proxy:<version>` and `api-proxy:latest`
   - `agent-act:<version>` and `agent-act:latest` (GitHub Actions parity image)

## Release Artifacts

Each release includes:

### GitHub Release Assets
- `awf-linux-x64` - Linux x64 standalone executable
- `awf-linux-arm64` - Linux arm64 standalone executable
- `awf.tgz` - NPM package tarball (alternative installation method)
- `checksums.txt` - SHA256 checksums for all files

### GitHub Container Registry (GHCR)
Docker images are published to `ghcr.io/github/gh-aw-firewall`:
- `squid:<version>` and `squid:latest` - Squid proxy container
- `agent:<version>` and `agent:latest` - Agent execution environment (minimal, ~200MB)
- `api-proxy:<version>` and `api-proxy:latest` - API proxy sidecar for credential isolation
- `agent-act:<version>` and `agent-act:latest` - Agent with GitHub Actions parity (~2GB)

These images are automatically pulled by the CLI when running commands.

The `agent-act` image is used when running with `--agent-image act` for workflows that need closer parity with GitHub Actions runner environments.

## Testing a Release Locally

Before releasing, you can test the build process locally:

### Test Binary Creation

```bash
# Install pkg globally
npm install -g pkg

# Build TypeScript
npm run build

# Create Linux binary
mkdir -p release
pkg . --targets node18-linux-x64 --output release/awf

# Test the binary (requires Docker images - see below)
./release/awf-linux --help
```

### Test Docker Images Locally

```bash
# Build images locally
docker build -t awf-test/squid:local ./containers/squid
docker build -t awf-test/agent:local ./containers/agent
docker build -t awf-test/api-proxy:local ./containers/api-proxy

# Test with local images
sudo ./dist/cli.js \
  --build-local \
  --allow-domains github.com \
  'curl https://github.com'

# Or test with existing GHCR images
sudo ./dist/cli.js \
  --allow-domains github.com \
  'curl https://github.com'
```

## Troubleshooting

### Release workflow fails

1. Check the **Actions** tab for error logs
2. Common issues:
   - Build errors: Check TypeScript compilation locally with `npm run build`
   - Docker build errors: Test image builds locally in `containers/` directories
   - GHCR push errors: Ensure `packages: write` permission is granted
   - Permission errors: Ensure repository has `contents: write` permission

### Binary doesn't work

1. Test locally before release
2. Ensure all dependencies are bundled (check `pkg.assets` in package.json)
3. For dynamic requires, you may need to mark files/directories in `pkg.assets`

### Docker images not available

If users report that Docker images can't be pulled:

1. Check **Packages** page to verify images were published
2. Verify image visibility is set to **Public** (not Private)
3. Check image tags match what the CLI expects (version + latest)
4. Users can use `--build-local` as a workaround while troubleshooting

To make packages public:
1. Go to repository **Packages** page
2. Click on the package (squid, agent, api-proxy, or agent-act)
3. Go to **Package settings**
4. Change visibility to **Public**

### Version mismatch

If you accidentally released the wrong version:

1. Delete the tag remotely: `git push origin :refs/tags/v0.1.0`
2. Delete the release from GitHub UI
3. Delete or retag the GHCR images if needed
4. Re-run the workflow with the correct bump type

## Pre-release Versions

Pre-release versions are not currently supported via the workflow dispatch input.
To create a pre-release, manually bump the version locally and push:

```bash
npm version prerelease --preid=alpha  # 0.1.0 -> 0.1.1-alpha.0
git push origin main --tags
```

The release workflow can then be triggered manually (it will read the pre-release version from `package.json` and skip the bump step since the tag already exists).

## Maintenance Releases

For backporting fixes to older major versions:

1. Create a maintenance branch: `git checkout -b v0.x`
2. Cherry-pick or apply fixes
3. Push branch: `git push origin v0.x`
4. Run the release workflow on the maintenance branch (select the `v0.x` branch in the UI)
