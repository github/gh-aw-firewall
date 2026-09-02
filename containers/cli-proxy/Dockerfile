# CLI Proxy sidecar for AWF - provides gh CLI access via external DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The DIFC proxy (mcpg) runs
# externally on the host, started by the gh-aw compiler.  A TCP tunnel
# forwards localhost traffic to the external proxy for TLS hostname matching.
#
FROM golang:1.26.6-alpine@sha256:af8d6740070b8906d12eae1c3e3ea0957fb63f492051ea05e354c38ef9fe88df AS gh-build

ARG GH_VERSION=2.97.0
ARG GH_SOURCE_SHA256=18cd1280f70911c9c16dd5965cdac0b9e6b16e54466f0c892ce2829ecdd339a6
ARG GH_SOURCE_DATE_EPOCH=1785488640
RUN wget -q "https://github.com/cli/cli/archive/refs/tags/v${GH_VERSION}.tar.gz" -O /tmp/gh.tar.gz \
    && echo "${GH_SOURCE_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && cd "/tmp/cli-${GH_VERSION}" \
    && CGO_ENABLED=0 GH_VERSION="${GH_VERSION}" SOURCE_DATE_EPOCH="${GH_SOURCE_DATE_EPOCH}" \
         go run ./script/build.go bin/gh \
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
COPY --from=gh-build /tmp/cli-2.97.0/bin/gh /usr/local/bin/gh
RUN gh --version | grep -qE '^gh version 2\.97\.0'

# Replace the vulnerable npm 10.x bundled with Node 22.23.2 with npm 11.18.0.
# npm 11.18.0 bundles: tar 7.5.19 (fixes GHSA-23hp-3jrh-7fpw/GHSA-8x88-c5mf-7j5w),
# sigstore 4.1.1 (fixes GHSA-52v5-jr5w-gjxr), brace-expansion 5.0.7 and
# picomatch 4.0.4 (via tinyglobby, fixes GHSA-3jxr-9vmj-r5cp / GHSA-c2c7-rcm5-vvqj).
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

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from lockfile (deterministic)
RUN npm ci --omit=dev

# Copy application files
COPY server.js security.js gh-runner.js access-log.js tcp-tunnel.js ./
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
