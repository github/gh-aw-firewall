# Node.js API proxy for credential management
# Routes through Squid to respect domain whitelisting
FROM node:22.23.1-alpine3.24

# Install curl for healthchecks (>=8.21.0-r0 to fix CVE in 8.20.x)
RUN apk add --no-cache "curl>=8.21.0-r0"

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
    node --version | grep -qE '^v22\.23\.1' || (echo "ERROR: expected Node.js v22.23.1" && exit 1); \
    npm --version | grep -qE '^11\.18\.0' || (echo "ERROR: expected npm 11.18.0" && exit 1); \
    rm -f /tmp/npm-11.18.0.tgz

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies from lockfile (deterministic)
RUN npm ci --omit=dev

# Copy application files
COPY server.js logging.js metrics.js rate-limiter.js rate-limiter-window.js \
     token-tracker.js token-persistence.js token-parsers.js \
     token-tracker-http.js token-tracker-ws.js token-tracker-shared.js \
     model-resolver.js model-fallback.js model-utils.js model-body-rewriter.js proxy-utils.js oidc-adapter-utils.js adapter-factory.js anthropic-transforms.js \
     model-config.js key-validation.js server-factory.js startup.js \
     proxy-request.js request-headers.js upstream-http.js proxy-guards.js proxy-error-handler.js http-client.js body-handler.js model-discovery.js management.js oidc-token-provider.js \
     oidc-token-provider-base.js \
     github-oidc.js aws-oidc-token-provider.js gcp-oidc-token-provider.js \
     anthropic-oidc-token-provider.js \
     ai-credits-pricing.js models-dev-catalog.js models.dev.catalog.json \
     oidc-refresh-utils.js body-transform.js body-utils.js rate-limit.js websocket-proxy.js \
     websocket-guards.js websocket-tunnel.js \
     deprecated-header-tracker.js billing-headers.js upstream-response.js \
     upstream-log.js upstream-retry.js upstream-token.js \
     anthropic-cache.js otel.js otel-exporters.js otel-serialization.js \
     token-budget-log.js blocked-request-diagnostics.js \
     provider-env-constants.js provider-env-constants.json provider-names.js \
     model-api-mapping.js model-api-mapping.json ./
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
# 10004 - Google Vertex AI API proxy
EXPOSE 10000 10001 10002 10003 10004

# Use exec form so node is PID 1 and receives SIGTERM directly
CMD ["node", "server.js"]
