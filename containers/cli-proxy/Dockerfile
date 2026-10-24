# CLI Proxy sidecar for AWF - provides gh CLI access via external DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The DIFC proxy (mcpg) runs
# externally on the host, started by the gh-aw compiler.  A TCP tunnel
# forwards localhost traffic to the external proxy for TLS hostname matching.
#
FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS gh-build
ENV GOTOOLCHAIN=go1.27.3

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
    && go version -m bin/gh | head -n 1 | grep -Eq ': go1\.27\.3$' \
    && go version -m bin/gh | awk -v version="v${GH_GRPC_VERSION}" \
         '$1 == "dep" && $2 == "google.golang.org/grpc" && $3 == version { found=1 } END { exit !found }' \
    && go version -m bin/gh | awk -v version="v${GH_X_CRYPTO_VERSION}" \
         '$1 == "dep" && $2 == "golang.org/x/crypto" && $3 == version { found=1 } END { exit !found }' \
    && go version -m bin/gh | awk -v version="v${GH_X_NET_VERSION}" \
         '$1 == "dep" && $2 == "golang.org/x/net" && $3 == version { found=1 } END { exit !found }' \
    && /tmp/cli-${GH_VERSION}/bin/gh --version

# Pin to a specific alpine version so the curl constraint below is stable.
FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a

# Install system packages.
# Alpine 3.24's stable repository still ships curl 8.22.0-r0, affected by
# CVE-2026-92392. Use the fixed edge package with an explicit minimum version.
# The alpine community repo includes github-cli — we replace it below with the
# official release binary to control the exact Go toolchain and module versions.
RUN apk upgrade --no-cache \
    && apk add --no-cache \
        ca-certificates \
        bash \
    && apk add --no-cache \
        --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main \
        "curl>=8.23.0-r0"

# Build the pinned GitHub CLI release with the patched Go toolchain.
COPY --from=gh-build /tmp/cli-2.98.0/bin/gh /usr/local/bin/gh
RUN gh --version | grep -qE '^gh version 2\.98\.0'

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
    npm --version | grep -qE '^12\.2\.1' || (echo "ERROR: npm 12.2.1 not installed" && exit 1); \
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
COPY trust/ /opt/awf/trust/
RUN apk add --no-cache openssl \
    && sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh
USER cliproxy

# Expose port for agent->cli-proxy HTTP communication
# 11000 - gh exec endpoint and health check
EXPOSE 11000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
