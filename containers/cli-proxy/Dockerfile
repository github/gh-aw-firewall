# CLI Proxy sidecar for AWF - provides gh CLI access with mcpg DIFC proxy
#
# Multi-stage build:
#   Stage 1: Extract mcpg binary from ghcr.io/github/gh-aw-mcpg image
#   Stage 2: Assemble final image with gh CLI, Node.js, and mcpg
#
# This container runs two processes:
#   1. mcpg proxy (TLS, port 18443) - holds GH_TOKEN, enforces guard policies
#   2. HTTP server (port 11000) - receives gh invocations from the agent container

# Stage 1: Extract the mcpg binary from the official gh-aw-mcpg image
FROM ghcr.io/github/gh-aw-mcpg:latest AS mcpg-source

# Stage 2: Build the CLI proxy image
FROM node:22-alpine

# Install gh CLI and curl for healthchecks/wrapper
# gh CLI is available in the Alpine community repository
RUN apk add --no-cache \
    curl \
    github-cli \
    ca-certificates \
    bash

# Copy the mcpg binary from the mcpg-source stage
COPY --from=mcpg-source /usr/local/bin/mcpg /usr/local/bin/mcpg
RUN chmod +x /usr/local/bin/mcpg

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

# Create log directory with open permissions so Node server (non-root) can write
RUN mkdir -p /var/log/cli-proxy/mcpg && chmod 777 /var/log/cli-proxy /var/log/cli-proxy/mcpg

# Create non-root user
RUN addgroup -S cliproxy && adduser -S cliproxy -G cliproxy

# Expose port for agent→cli-proxy HTTP communication
# 11000 - gh exec endpoint and health check
EXPOSE 11000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
