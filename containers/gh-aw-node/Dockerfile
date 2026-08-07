# Minimal Node.js Alpine image for the gh-aw safeoutputs MCP server.
#
# This image is used by the gh-aw compiler as the safeoutputs container
# (ghcr.io/github/gh-aw-firewall/gh-aw-node). It provides the minimal
# Alpine + Node.js runtime required to execute the safeoutputs MCP server.
#
# Security patches applied in this build:
#
#   libcrypto3/libssl3 >= 3.5.7: resolved by using node:22.23.2-alpine3.24
#     and running `apk upgrade --no-cache` to pull in the latest Alpine 3.24
#     security-patched builds of openssl.
#
#   musl CVE-2026-40200: Alpine 3.24's musl APKBUILD explicitly lists
#     CVE-2026-40200 under the 1.2.6-r2 secfixes entry and applies its
#     backport patch; no additional steps are required.
#
#   tar >= 7.5.19 (GHSA-23hp-3jrh-7fpw / GHSA-8x88-c5mf-7j5w),
#   brace-expansion >= 5.0.7 (GHSA-3jxr-9vmj-r5cp / GHSA-c2c7-rcm5-vvqj),
#   sigstore >= 4.1.1 (GHSA-52v5-jr5w-gjxr): resolved by replacing the
#     npm 10.x bundle that ships with Node 22.23.2 with npm 11.18.0, which
#     carries all three fixed transitive dependencies.
#
#   undici >= 6.27.0: Node.js 22.23.2 bundles a patched undici (the Node.js
#     fetch API implementation), which meets the required floor; no separate fix needed.
#
#   curl >= 8.21.0-r0 (CVE-2026-8924/8925/8926/8927/9079/10536/11564/11856):
#     resolved by pinning the apk constraint below.
FROM node:22.23.2-alpine3.24

# Install curl for healthchecks and the npm tarball download below.
# Pin >= 8.21.0-r0 to fix CVE-2026-8924/8925/8926/8927/9079/10536/11564/11856
# (Alpine 3.24 ships 8.20.0-r1 by default; this constraint forces the patched build).
# Also run apk upgrade to pull in latest libcrypto3 >= 3.5.7 and libssl3 patches.
RUN apk upgrade --no-cache && \
    apk add --no-cache "curl>=8.21.0-r0" git

# Replace the vulnerable npm 10.x bundled with Node 22.23.2 with npm 11.18.0.
# npm 11.18.0 bundles: tar 7.5.19 (fixes GHSA-23hp-3jrh-7fpw/GHSA-8x88-c5mf-7j5w),
# sigstore 4.1.1 (fixes GHSA-52v5-jr5w-gjxr), brace-expansion 5.0.7 and
# picomatch 4.0.4 (via tinyglobby, fixes GHSA-3jxr-9vmj-r5cp / GHSA-c2c7-rcm5-vvqj).
# Install from the registry tarball (same method as the api-proxy image) for a clean
# replacement -- avoids leaving stale npm 10.x bundles in the image layers.
RUN set -eux; \
    NPM_TGZ_URL="https://registry.npmjs.org/npm/-/npm-11.18.0.tgz"; \
    NPM_TGZ_SHA256="73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e"; \
    curl -fsSL "$NPM_TGZ_URL" -o /tmp/npm-11.18.0.tgz; \
    echo "${NPM_TGZ_SHA256}  /tmp/npm-11.18.0.tgz" | sha256sum -c -; \
    rm -rf /usr/local/lib/node_modules/npm; \
    mkdir -p /usr/local/lib/node_modules/npm; \
    tar -xzf /tmp/npm-11.18.0.tgz -C /usr/local/lib/node_modules/npm --strip-components=1; \
    chmod +x /usr/local/lib/node_modules/npm/bin/npm-cli.js \
             /usr/local/lib/node_modules/npm/bin/npx-cli.js; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    node --version | grep -qE '^v22\.23\.2' || (echo "ERROR: expected Node.js v22.23.2" && exit 1); \
    npm --version | grep -qE '^11\.18\.0' || (echo "ERROR: expected npm 11.18.0" && exit 1); \
    rm -f /tmp/npm-11.18.0.tgz

LABEL org.opencontainers.image.source="https://github.com/github/gh-aw-firewall"
LABEL org.opencontainers.image.description="Minimal Node.js Alpine image for gh-aw safeoutputs MCP server"

# AWF version baked into the image at release build time.
ARG AWF_VERSION=0.0.0-dev
ENV AWF_VERSION=${AWF_VERSION}
