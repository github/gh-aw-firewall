# CLI Proxy sidecar for AWF - provides gh CLI access via external DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The DIFC proxy (mcpg) runs
# externally on the host, started by the gh-aw compiler.  A TCP tunnel
# forwards localhost traffic to the external proxy for TLS hostname matching.
#
# Pin to a specific alpine version so the curl constraint below is stable.
FROM node:22.23.1-alpine3.24

# Install system packages.
# Pin curl >= 8.21.0-r0 to fix CVE-2026-8924/8925/8926/8927/9079/10536/11564/11856
# (Alpine 3.24 ships 8.20.0-r1 by default; the constraint forces the patched build).
# The alpine community repo includes github-cli — we replace it below with the
# official release binary to control the exact Go toolchain and module versions.
RUN apk add --no-cache \
    "curl>=8.21.0-r0" \
    ca-certificates \
    bash

# Install gh CLI 2.96.0 from the official GitHub CLI release.
# This binary is compiled with Go 1.26.4 (fixing GO-2026-5037 / stdlib 1.26.3->1.26.4)
# and ships with sigstore/rekor v1.5.2 (fixing GHSA-47q9-m4ww-924m).
# Checksums sourced from https://github.com/cli/cli/releases/tag/v2.96.0
RUN set -eux; \
    GH_VERSION="2.96.0"; \
    ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64)  GH_ARCH="amd64"; GH_SHA256="83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60" ;; \
      aarch64) GH_ARCH="arm64"; GH_SHA256="06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909" ;; \
      armv6l|armv7l) GH_ARCH="armv6"; GH_SHA256="14ff25ec64823415086214fb05b3e85aef21deba6a8d723a7ef8ead1cb977826" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    GH_TGZ="gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TGZ}" \
        -o "/tmp/${GH_TGZ}"; \
    echo "${GH_SHA256}  /tmp/${GH_TGZ}" | sha256sum -c -; \
    tar -xzf "/tmp/${GH_TGZ}" -C /tmp/; \
    mv "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh; \
    chmod +x /usr/local/bin/gh; \
    rm -rf "/tmp/${GH_TGZ}" "/tmp/gh_${GH_VERSION}_linux_${GH_ARCH}"; \
    gh --version

# Replace the vulnerable npm 10.x bundled with Node 22.23.1 with npm 11.18.0.
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
