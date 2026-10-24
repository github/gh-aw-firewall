# Node.js API proxy for credential management
# Routes through Squid to respect domain whitelisting
FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a

# Install current Alpine security updates and curl for healthchecks. Alpine 3.24's
# stable repository still ships curl 8.22.0-r0, affected by CVE-2026-92392.
RUN apk upgrade --no-cache \
    && apk add --no-cache openssl ca-certificates \
    && apk add --no-cache \
        --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main \
        "curl>=8.23.0-r0"

COPY trust/ /opt/awf/trust/
RUN sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh

# Install pinned npm and its patched bundled dependencies in one layer so the
# vulnerable upstream copies are not retained in an earlier image layer.
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
    node --version | grep -qE '^v26\.11\.1' || (echo "ERROR: expected Node.js v26.11.1" && exit 1); \
    npm --version | grep -qE '^11\.18\.0' || (echo "ERROR: expected npm 11.18.0" && exit 1); \
    npm_dir=/usr/local/lib/node_modules/npm/node_modules; \
    curl -fsSL https://registry.npmjs.org/undici/-/undici-6.28.1.tgz -o /tmp/undici-6.28.1.tgz; \
    echo "e18191aac9c0ff43dac7fe9b10b7041a22d07addb7b66a6e8ac14a52a5b69b74  /tmp/undici-6.28.1.tgz" | sha256sum -c -; \
    curl -fsSL https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz -o /tmp/brace-expansion-5.0.12.tgz; \
    echo "ef8448ec78f20b692f04fa6d01f39b5ab34c66404bea3429f5a39c6c9e0be8b4  /tmp/brace-expansion-5.0.12.tgz" | sha256sum -c -; \
    curl -fsSL https://registry.npmjs.org/ip-address/-/ip-address-10.7.4.tgz -o /tmp/ip-address-10.7.4.tgz; \
    echo "f9e1d0dd369c002f43770c6ee35942c8078e76d080a1e18e89113eef865f26ff  /tmp/ip-address-10.7.4.tgz" | sha256sum -c -; \
    curl -fsSL https://registry.npmjs.org/postcss-selector-parser/-/postcss-selector-parser-7.1.6.tgz -o /tmp/postcss-selector-parser-7.1.6.tgz; \
    echo "48c903f98c5591d8d26f16f389d5cb3435459474c645209a79f6241bf4b657b6  /tmp/postcss-selector-parser-7.1.6.tgz" | sha256sum -c -; \
    rm -rf "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address" "$npm_dir/postcss-selector-parser"; \
    mkdir -p "$npm_dir/undici" "$npm_dir/brace-expansion" "$npm_dir/ip-address" "$npm_dir/postcss-selector-parser"; \
    tar -xzf /tmp/undici-6.28.1.tgz -C "$npm_dir/undici" --strip-components=1; \
    tar -xzf /tmp/brace-expansion-5.0.12.tgz -C "$npm_dir/brace-expansion" --strip-components=1; \
    tar -xzf /tmp/ip-address-10.7.4.tgz -C "$npm_dir/ip-address" --strip-components=1; \
    tar -xzf /tmp/postcss-selector-parser-7.1.6.tgz -C "$npm_dir/postcss-selector-parser" --strip-components=1; \
    node -e 'const root="/usr/local/lib/node_modules/npm/node_modules"; const expected={undici:"6.28.1","brace-expansion":"5.0.12","ip-address":"10.7.4","postcss-selector-parser":"7.1.6"}; for (const [name, version] of Object.entries(expected)) { const actual=require(`${root}/${name}/package.json`).version; if (actual !== version) throw new Error(`${name}: expected ${version}, got ${actual}`); }'; \
    rm -f /tmp/npm-11.18.0.tgz /tmp/undici-6.28.1.tgz /tmp/brace-expansion-5.0.12.tgz /tmp/ip-address-10.7.4.tgz /tmp/postcss-selector-parser-7.1.6.tgz

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
     model-resolver.js model-fallback.js model-fallback-chain.js model-utils.js model-body-rewriter.js proxy-utils.js oidc-adapter-utils.js adapter-factory.js anthropic-transforms.js claude-hosted-web.js codex-hosted-web.js hosted-web-policy.js \
     model-config.js model-selector.js scoped-auto-model.js key-validation.js server-factory.js startup.js \
     proxy-request.js request-headers.js upstream-http.js proxy-guards.js proxy-error-handler.js http-client.js body-handler.js reasoning-effort-validation.js model-discovery.js management.js oidc-token-provider.js \
     oidc-token-provider-base.js \
     github-oidc.js aws-oidc-token-provider.js aws-sigv4.js gcp-oidc-token-provider.js \
     anthropic-oidc-token-provider.js \
     ai-credits-pricing.js model-pricing-catalog.js models-dev-catalog.js models.dev.catalog.json \
     model-information.pricing.generated.json model-information.retired.generated.json \
     provider-pricing-overlays.js runtime-model-catalog.js catalogue-loader.js catalogue-pricing.js \
     oidc-refresh-utils.js body-transform.js body-utils.js codex-compat.js wire-api-compat.js rate-limit.js websocket-proxy.js \
     anthropic-chat-compat.js cross-provider-fallback.js \
     websocket-guards.js websocket-tunnel.js \
     deprecated-header-tracker.js billing-headers.js upstream-response.js \
     upstream-log.js upstream-retry.js upstream-token.js copilot-auth-diagnostics.js \
     anthropic-cache.js otel.js otel-exporters.js otel-serialization.js otel-workload-identity.js \
     token-budget-log.js enclave-model-budget.js blocked-request-diagnostics.js caller-header.js \
     provider-env-constants.js provider-env-constants.json provider-names.js \
     model-api-mapping.js model-api-mapping.json provider-error-fields.js \
     routing-candidates.js routing-catalogue.js routing-classifier.js routing-config.js \
     routing-contract.js routing-controller.js routing-errors.js routing-observation.js \
     routing-planner.js routing-provider-executor.js routing-router-client.js routing-runtime.js routing-persistence.js ./
COPY guards/ ./guards/
COPY providers/ ./providers/
COPY transforms/ ./transforms/
COPY catalogue-contract/ ./catalogue-contract/

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
CMD ["node", "--require=/opt/awf/trust/node-trust.cjs", "server.js"]
