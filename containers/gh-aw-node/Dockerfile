# Minimal Node.js Alpine image for the gh-aw safeoutputs MCP server.
#
# This image is used by the gh-aw compiler as the safeoutputs container
# (ghcr.io/github/gh-aw-firewall/gh-aw-node). It provides the minimal
# Alpine + Node.js runtime required to execute the safeoutputs MCP server.
#
# Security patches applied in this build:
#
#   libcrypto3/libssl3 >= 3.5.7: resolved by using node:26.11.1-alpine3.24
#     and running `apk upgrade --no-cache` to pull in the latest Alpine 3.24
#     security-patched builds of openssl.
#
#   musl CVE-2026-40200: Alpine 3.24's musl APKBUILD explicitly lists
#     CVE-2026-40200 under the 1.2.6-r2 secfixes entry and applies its
#     backport patch; no additional steps are required.
#
#   npm's bundled undici, brace-expansion, and ip-address: replaced with
#     pinned fixed releases after installing npm 12.2.1 below.
#
#   curl >= 8.23.0-r0: Alpine 3.24's stable repository still ships curl
#     8.22.0-r0, affected by CVE-2026-92392, so the fixed package is installed
#     from edge.
FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a

# Install curl for healthchecks and the npm tarball download below.
# Also run apk upgrade to pull in latest libcrypto3 >= 3.5.7 and libssl3 patches.
RUN apk upgrade --no-cache && \
    apk add --no-cache git && \
    apk add --no-cache \
        --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main \
        "curl>=8.23.0-r0"

# Install pinned npm and its patched bundled dependencies in one layer so the
# vulnerable upstream copies are not retained in an earlier image layer.
RUN set -eux; \
    NPM_TGZ_URL="https://registry.npmjs.org/npm/-/npm-12.2.1.tgz"; \
    NPM_TGZ_SHA256="228bd64aaef23270dbdbd2cf3d5ef5c467602ef38c4066246cef1984adab9a67"; \
    curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 --connect-timeout 15 --max-time 60 "$NPM_TGZ_URL" -o /tmp/npm-12.2.1.tgz; \
    echo "${NPM_TGZ_SHA256}  /tmp/npm-12.2.1.tgz" | sha256sum -c -; \
    rm -rf /usr/local/lib/node_modules/npm; \
    mkdir -p /usr/local/lib/node_modules/npm; \
    tar -xzf /tmp/npm-12.2.1.tgz -C /usr/local/lib/node_modules/npm --strip-components=1; \
    chmod +x /usr/local/lib/node_modules/npm/bin/npm-cli.js \
             /usr/local/lib/node_modules/npm/bin/npx-cli.js; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    node --version | grep -qE '^v26\.11\.1' || (echo "ERROR: expected Node.js v26.11.1" && exit 1); \
    npm --version | grep -qE '^12\.2\.1' || (echo "ERROR: expected npm 12.2.1" && exit 1); \
    npm_dir=/usr/local/lib/node_modules/npm/node_modules; \
    curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 --connect-timeout 15 --max-time 60 https://registry.npmjs.org/undici/-/undici-6.29.1.tgz -o /tmp/undici-6.29.1.tgz; \
    echo "29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  /tmp/undici-6.29.1.tgz" | sha256sum -c -; \
    curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 --connect-timeout 15 --max-time 60 https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz -o /tmp/brace-expansion-5.0.12.tgz; \
    echo "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4  /tmp/brace-expansion-5.0.12.tgz" | sha256sum -c -; \
    curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 --connect-timeout 15 --max-time 60 https://registry.npmjs.org/ip-address/-/ip-address-10.7.4.tgz -o /tmp/ip-address-10.7.4.tgz; \
    echo "f9e1d0dd369c002f43770c6ee35942c8078e76d080a1e18e89113eef865f26ff  /tmp/ip-address-10.7.4.tgz" | sha256sum -c -; \
    curl -fsSL --retry 3 --retry-all-errors --retry-max-time 120 --connect-timeout 15 --max-time 60 https://registry.npmjs.org/postcss-selector-parser/-/postcss-selector-parser-7.1.6.tgz -o /tmp/postcss-selector-parser-7.1.6.tgz; \
    echo "48c903f98c5591d8d26f16f389d5cb3435459474c645209a79f6241bf4b657b6  /tmp/postcss-selector-parser-7.1.6.tgz" | sha256sum -c -; \
    rm -rf "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address" "$npm_dir/postcss-selector-parser"; \
    mkdir -p "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address" "$npm_dir/postcss-selector-parser"; \
    tar -xzf /tmp/undici-6.29.1.tgz -C "$npm_dir/undici" --strip-components=1; \
    tar -xzf /tmp/brace-expansion-5.0.12.tgz -C "$npm_dir/brace-expansion" --strip-components=1; \
    tar -xzf /tmp/ip-address-10.7.4.tgz -C "$npm_dir/ip-address" --strip-components=1; \
    tar -xzf /tmp/postcss-selector-parser-7.1.6.tgz -C "$npm_dir/postcss-selector-parser" --strip-components=1; \
    node -e 'const root="/usr/local/lib/node_modules/npm/node_modules"; const expected={undici:"6.29.1","brace-expansion":"5.0.12","ip-address":"10.7.4","postcss-selector-parser":"7.1.6"}; for (const [name, version] of Object.entries(expected)) { const actual=require(`${root}/${name}/package.json`).version; if (actual !== version) throw new Error(`${name}: expected ${version}, got ${actual}`); }'; \
    rm -f /tmp/npm-12.2.1.tgz /tmp/undici-6.29.1.tgz /tmp/brace-expansion-5.0.12.tgz /tmp/ip-address-10.7.4.tgz /tmp/postcss-selector-parser-7.1.6.tgz

LABEL org.opencontainers.image.source="https://github.com/github/gh-aw-firewall"
LABEL org.opencontainers.image.description="Minimal Node.js Alpine image for gh-aw safeoutputs MCP server"

# AWF version baked into the image at release build time.
ARG AWF_VERSION=0.0.0-dev
ENV AWF_VERSION=${AWF_VERSION}

COPY trust/ /opt/awf/trust/
RUN apk add --no-cache openssl ca-certificates \
    && sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh
