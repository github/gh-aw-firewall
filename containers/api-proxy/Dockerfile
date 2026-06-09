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
COPY server.js logging.js metrics.js rate-limiter.js \
     token-tracker.js token-persistence.js token-parsers.js \
     token-tracker-http.js token-tracker-ws.js \
     model-resolver.js proxy-utils.js anthropic-transforms.js \
     model-config.js key-validation.js server-factory.js startup.js \
     proxy-request.js model-discovery.js management.js oidc-token-provider.js \
     oidc-token-provider-base.js \
     github-oidc.js aws-oidc-token-provider.js gcp-oidc-token-provider.js \
     anthropic-oidc-token-provider.js \
     ai-credits-pricing.js models-dev-catalog.js models.dev.catalog.json \
     oidc-refresh-utils.js body-transform.js body-utils.js rate-limit.js websocket-proxy.js \
     deprecated-header-tracker.js billing-headers.js upstream-response.js \
     anthropic-cache.js otel.js token-budget-log.js ./
COPY guards/ ./guards/
COPY providers/ ./providers/
COPY transforms/ ./transforms/

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
EXPOSE 10000 10001 10002 10003

# Use exec form so node is PID 1 and receives SIGTERM directly
CMD ["node", "server.js"]
