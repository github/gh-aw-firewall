# CLI Proxy sidecar for AWF - provides gh CLI access via mcpg DIFC proxy
#
# This container runs the HTTP exec server (port 11000) that receives gh
# invocations from the agent container.  The mcpg DIFC proxy runs as a
# separate docker-compose service (awf-cli-proxy-mcpg) using the official
# gh-aw-mcpg image directly — no binary extraction needed.  GH_HOST is
# set to the mcpg container so all gh CLI traffic flows through the proxy.
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
COPY server.js ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

# Create non-root user
RUN addgroup -S cliproxy && adduser -S cliproxy -G cliproxy

# Create log directory owned by cliproxy (so non-root process can write)
RUN mkdir -p /var/log/cli-proxy && \
    chown -R cliproxy:cliproxy /var/log/cli-proxy

# Create /tmp/proxy-tls directory owned by cliproxy for shared mcpg TLS certs
RUN mkdir -p /tmp/proxy-tls && chown cliproxy:cliproxy /tmp/proxy-tls

# Switch to non-root user
USER cliproxy

# Expose port for agent→cli-proxy HTTP communication
# 11000 - gh exec endpoint and health check
EXPOSE 11000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
