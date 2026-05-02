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
COPY server.js logging.js metrics.js rate-limiter.js token-tracker.js \
     model-resolver.js proxy-utils.js anthropic-cache.js anthropic-transforms.js ./
COPY providers/ ./providers/

# Create non-root user
RUN addgroup -S apiproxy && adduser -S apiproxy -G apiproxy

# Switch to non-root user
USER apiproxy

# AWF version baked into the image at release build time.
# The release workflow passes --build-arg AWF_VERSION=<tag> so that
# token-usage.jsonl records carry the exact api-proxy image version.
# Falls back to "0.0.0-dev" for local/un-versioned builds.
ARG AWF_VERSION=0.0.0-dev
ENV AWF_VERSION=${AWF_VERSION}

# Expose ports
# 10000 - OpenAI API proxy (also serves as health check endpoint)
# 10001 - Anthropic API proxy
# 10002 - GitHub Copilot API proxy
# 10003 - Google Gemini API proxy
# 10004 - OpenCode API proxy (routes to Anthropic)
EXPOSE 10000 10001 10002 10003 10004

# Use exec form so node is PID 1 and receives SIGTERM directly
CMD ["node", "server.js"]
