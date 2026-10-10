# CLI Proxy sidecar for AWF - provides gh CLI access via external DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The DIFC proxy (mcpg) runs
# externally on the host, started by the gh-aw compiler.  A TCP tunnel
# forwards localhost traffic to the external proxy for TLS hostname matching.
#
FROM golang:1.26.9-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS gh-build

ARG GH_VERSION=2.98.0
ARG GH_SOURCE_SHA256=abada9e8b550547ac93f99250f3ad4d90ad623fa245cb54cb058f78030a6a5f6
ARG GH_SOURCE_DATE_EPOCH=1787263311
ARG GH_GRPC_VERSION=1.83.2
ARG GH_X_CRYPTO_VERSION=0.57.0
ARG GH_X_NET_VERSION=0.60.0
RUN wget -q "https://github.com/cli/cli/archive/refs/tags/v${GH_VERSION}.tar.gz" -O /tmp/gh.tar.gz \
    && echo "${GH_SOURCE_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && cd "/tmp/cli-${GH_VERSION}" \
    && go get "google.golang.org/grpc@v${GH_GRPC_VERSION}" "golang.org/x/crypto@v${GH_X_CRYPTO_VERSION}" "golang.org/x/net@v${GH_X_NET_VERSION}" \
    && CGO_ENABLED=0 GH_VERSION="${GH_VERSION}" SOURCE_DATE_EPOCH="${GH_SOURCE_DATE_EPOCH}" \
         go run ./script/build.go bin/gh \
    && go version -m bin/gh | awk -v version="v${GH_GRPC_VERSION}" \
         '$1 == "dep" && $2 == "google.golang.org/grpc" && $3 == version { found=1 } END { exit !found }' \
    && go version -m bin/gh | awk -v version="v${GH_X_CRYPTO_VERSION}" \
         '$1 == "dep" && $2 == "golang.org/x/crypto" && $3 == version { found=1 } END { exit !found }' \
    && go version -m bin/gh | awk -v version="v${GH_X_NET_VERSION}" \
         '$1 == "dep" && $2 == "golang.org/x/net" && $3 == version { found=1 } END { exit !found }' \
    && /tmp/cli-${GH_VERSION}/bin/gh --version

# Pin to a specific alpine version so the curl constraint below is stable.
FROM node:22.23.2-alpine3.24

# Install system packages.
# Pin curl >= 8.21.0-r0 to fix CVE-2026-8924/8925/8926/8927/9079/10536/11564/11856
# (Alpine 3.24 ships 8.20.0-r1 by default; the constraint forces the patched build).
# The alpine community repo includes github-cli — we replace it below with the
# official release binary to control the exact Go toolchain and module versions.
RUN apk upgrade --no-cache \
    && apk add --no-cache \
        "curl>=8.21.0-r0" \
        ca-certificates \
        bash

# Build the pinned GitHub CLI release with the patched Go toolchain.
COPY --from=gh-build /tmp/cli-2.98.0/bin/gh /usr/local/bin/gh
RUN gh --version | grep -qE '^gh version 2\.98\.0'

# Replace the vulnerable npm 10.x bundled with Node 22.23.2 with npm 11.18.0.
# npm 11.18.0 bundles vulnerable copies of undici, brace-expansion, and
# ip-address; the pinned replacements below install fixed releases.
# Install from the registry tarball (same method as the agent image) for a clean
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
    npm --version | grep -qE '^11\.18\.0' || (echo "ERROR: npm 11.18.0 not installed" && exit 1); \
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

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from lockfile (deterministic)
RUN npm ci --omit=dev

# Copy application files
COPY server.js security.js gh-runner.js access-log.js tcp-tunnel.js gh-http-shim.js github-api-point-limiter.js ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Create non-root user
RUN addgroup -S cliproxy && adduser -S cliproxy -G cliproxy

# Create log directory owned by cliproxy (so non-root process can write)
RUN mkdir -p /var/log/cli-proxy && \
    chown -R cliproxy:cliproxy /var/log/cli-proxy

# Create /tmp/proxy-tls directory owned by cliproxy for mounted DIFC proxy CA cert
RUN mkdir -p /tmp/proxy-tls && chown cliproxy:cliproxy /tmp/proxy-tls

# Switch to non-root user
USER cliproxy

# Expose port for agent->cli-proxy HTTP communication
# 11000 - gh exec endpoint and health check
EXPOSE 11000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
