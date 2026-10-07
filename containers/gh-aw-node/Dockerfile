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
#   npm's bundled undici, brace-expansion, and ip-address: replaced with
#     pinned fixed releases after installing npm 11.18.0 below.
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

# Replace Node's bundled npm 10.x with npm 11.18.0.
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

# Replace vulnerable npm-bundled dependencies without changing the pinned npm release.
RUN set -eux; \
    npm_dir=/usr/local/lib/node_modules/npm/node_modules; \
    curl -fsSL https://registry.npmjs.org/undici/-/undici-6.28.1.tgz -o /tmp/undici-6.28.1.tgz; \
    echo "e18191aac9c0ff43dac7fe9b10b7041a22d07addb7b66a6e8ac14a52a5b69b74  /tmp/undici-6.28.1.tgz" | sha256sum -c -; \
    curl -fsSL https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz -o /tmp/brace-expansion-5.0.12.tgz; \
    echo "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4  /tmp/brace-expansion-5.0.12.tgz" | sha256sum -c -; \
    curl -fsSL https://registry.npmjs.org/ip-address/-/ip-address-10.7.1.tgz -o /tmp/ip-address-10.7.1.tgz; \
    echo "7f99ac7abda701afe1fd1e36de462236fb4d1eb8c595d7ae0267bba7d8ee55f8  /tmp/ip-address-10.7.1.tgz" | sha256sum -c -; \
    rm -rf "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address"; \
    mkdir -p "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address"; \
    tar -xzf /tmp/undici-6.28.1.tgz -C "$npm_dir/undici" --strip-components=1; \
    tar -xzf /tmp/brace-expansion-5.0.12.tgz -C "$npm_dir/brace-expansion" --strip-components=1; \
    tar -xzf /tmp/ip-address-10.7.1.tgz -C "$npm_dir/ip-address" --strip-components=1; \
    node -e 'const root="/usr/local/lib/node_modules/npm/node_modules"; const expected={undici:"6.28.1","brace-expansion":"5.0.12","ip-address":"10.7.1"}; for (const [name, version] of Object.entries(expected)) { const actual=require(`${root}/${name}/package.json`).version; if (actual !== version) throw new Error(`${name}: expected ${version}, got ${actual}`); }'; \
    rm -f /tmp/undici-6.28.1.tgz /tmp/brace-expansion-5.0.12.tgz /tmp/ip-address-10.7.1.tgz

LABEL org.opencontainers.image.source="https://github.com/github/gh-aw-firewall"
LABEL org.opencontainers.image.description="Minimal Node.js Alpine image for gh-aw safeoutputs MCP server"

# AWF version baked into the image at release build time.
ARG AWF_VERSION=0.0.0-dev
ENV AWF_VERSION=${AWF_VERSION}
