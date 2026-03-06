# Node.js API proxy for credential management
# Routes through Squid to respect domain whitelisting
FROM node:22-alpine

# Install curl for healthchecks
RUN apk add --no-cache curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from lockfile (deterministic)
RUN npm ci --omit=dev

# Copy application files
COPY server.js logging.js metrics.js rate-limiter.js ./

# Create non-root user
RUN addgroup -S apiproxy && adduser -S apiproxy -G apiproxy

# Switch to non-root user
USER apiproxy

# Expose ports
# 10000 - OpenAI API proxy (also serves as health check endpoint)
# 10001 - Anthropic API proxy
# 10002 - GitHub Copilot API proxy
# 10004 - OpenCode API proxy (routes to Anthropic)
EXPOSE 10000 10001 10002 10004

# Use exec form so Node.js is PID 1 and receives SIGTERM directly
# Docker captures stdout/stderr automatically, no need for manual log redirection
CMD ["node", "server.js"]
