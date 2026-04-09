# CLI Proxy sidecar for AWF - provides gh CLI access via external DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The DIFC proxy (mcpg) runs
# externally on the host, started by the gh-aw compiler.  A TCP tunnel
# forwards localhost traffic to the external proxy for TLS hostname matching.
FROM node:22-alpine

# Install gh CLI and curl for healthchecks/wrapper
# gh CLI is available in the Alpine community repository
RUN apk add --no-cache \
    curl \
    github-cli \
    ca-certificates \
    bash

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from lockfile (deterministic)
RUN npm ci --omit=dev

# Copy application files
COPY server.js tcp-tunnel.js ./
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

# Expose port for agent→cli-proxy HTTP communication
# 11000 - gh exec endpoint and health check
EXPOSE 11000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
