# AWF enclave images. Build context: containers/.
# Supply the release's build-tools digest, or a locally built base via BuildKit context.
ARG BUILD_TOOLS_IMAGE=awf-build-tools

FROM python:3.14.10-alpine3.24@sha256:eb2c62658b8d51bff0acc408504b76521d02030de56a8a3c1e830083e89b89d2 AS enclave-script

RUN apk upgrade --no-cache \
    && python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && ln -s /usr/local/bin/python3 /usr/bin/python3
COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script
COPY enclave/public_debug_capture.py /usr/local/bin/public_debug_capture.py
RUN chmod 0555 /usr/local/bin/run-enclave-script \
    && mkdir -p /script /awf/seed
COPY trust/ /opt/awf/trust/
RUN apk add --no-cache openssl ca-certificates \
    && sh /opt/awf/trust/install-system-trust.sh \
    && rm -f /sbin/apk

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS enclave-agent-build

COPY trust/ /opt/awf/trust/
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && sh /opt/awf/trust/install-system-trust.sh \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS="--require=/opt/awf/trust/node-trust.cjs"

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
COPY enclave/package*.json /tmp/copilot-cli/
RUN npm_config_ignore_scripts=false npm ci --prefix /tmp/copilot-cli --install-strategy=nested \
    && mkdir -p /usr/local/lib/node_modules/@github/copilot \
    && cp -a /tmp/copilot-cli/node_modules/@github/copilot/. /usr/local/lib/node_modules/@github/copilot/ \
    && mkdir -p /usr/local/lib/node_modules/@github/copilot/node_modules \
    && cp -a /tmp/copilot-cli/node_modules/. /usr/local/lib/node_modules/@github/copilot/node_modules/ \
    && rm -rf /usr/local/lib/node_modules/@github/copilot/node_modules/@github/copilot \
    && ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && find /usr/local/lib/node_modules/@github/copilot \
         -path '*/foundry-local-sdk/node_modules/adm-zip' -prune -type d \
         -exec sh -c 'rm -rf "$1" && cp -a /usr/local/lib/node_modules/@github/copilot/node_modules/adm-zip "$1"' sh {} \; \
    && COPILOT_CLI_VERSION="$(node -p 'require("/usr/local/lib/node_modules/@github/copilot/package.json").version')" \
    && COPILOT_CACHE_HOME=/usr/local/lib/node_modules/@github/copilot/cache \
         copilot --no-auto-update --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}" \
    && ln -s "cache/pkg/$(node -p 'process.platform + "-" + process.arch')/${COPILOT_CLI_VERSION}" \
         /usr/local/lib/node_modules/@github/copilot/runtime \
    && test -r /usr/local/lib/node_modules/@github/copilot/runtime/index.js

FROM ${BUILD_TOOLS_IMAGE} AS enclave-agent

ARG BUILD_TOOLS_IMAGE
LABEL org.opencontainers.image.base.name="${BUILD_TOOLS_IMAGE}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 python3 ripgrep \
    && /usr/bin/ip -Version \
    && gcc --version && make --version && cmake --version && gh --version \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache
COPY --from=enclave-agent-build /usr/local/bin/node /usr/local/bin/node
COPY trust/ /opt/awf/trust/
RUN sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh
COPY --from=enclave-agent-build /usr/local/lib/node_modules/@github/copilot/ /usr/local/lib/node_modules/@github/copilot/
# The pinned SEA loader supports this fixed distribution path. Never extract
# native addons into the invocation's writable, noexec HOME.
ENV COPILOT_CLI_DIST_DIR=/usr/local/lib/node_modules/@github/copilot/runtime
# Avoid uutils env's executable-name check on shebangs under BuildKit's QEMU.
RUN sed -i '1c#!/usr/local/bin/node' /usr/local/lib/node_modules/@github/copilot/npm-loader.js \
    && ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && chown -R 0:0 /usr/local/lib/node_modules/@github/copilot \
    && chmod -R a+rX,a-w /usr/local/lib/node_modules/@github/copilot \
    && node --version | grep -qE '^v26\.' \
    && COPILOT_CLI_VERSION="$(node -p 'require("/usr/local/lib/node_modules/@github/copilot/package.json").version')" \
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}" \
    && rm -f /usr/bin/pebble \
    && rm -rf /root/.cache/copilot
COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent
COPY enclave/public_debug_capture.py /usr/local/bin/public_debug_capture.py
RUN chmod 0555 /usr/local/bin/run-enclave-agent \
    && python3 -m py_compile /usr/local/bin/run-enclave-agent \
    && rm -rf /usr/local/bin/__pycache__ \
    && mkdir -p /agent /awf/seed /run/awf-enclave-github

FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS enclave-mcp-server

COPY trust/ /opt/awf/trust/
RUN apk add --no-cache openssl ca-certificates \
    && apk upgrade --no-cache \
    && apk add --no-cache docker-cli \
    && sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh \
    && test -x /usr/bin/docker \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ARG AWF_SOURCE_REVISION=unavailable
WORKDIR /opt/awf/enclave/mcp-server
LABEL org.opencontainers.image.revision="${AWF_SOURCE_REVISION}"
COPY bounded-execution/ /opt/awf/bounded-execution/
COPY enclave/script-executor/ /opt/awf/enclave/script-executor/
COPY enclave/agent-executor/ /opt/awf/enclave/agent-executor/
COPY enclave/mcp-server/ /opt/awf/enclave/mcp-server/
COPY enclave/seccomp.json /opt/awf/script-seccomp.json
COPY enclave/seccomp.json /opt/awf/enclave-seccomp.json

RUN chmod -R a-w /opt/awf \
    && find /opt/awf -name '*.js' -type f -exec node --check {} \; \
    && node -e "require('/opt/awf/enclave/mcp-server/agent-executor.js')"

RUN mkdir -p /srv/awf/seeds /srv/awf/work \
      /run/awf-enclave-mcp /run/awf-enclave-mcp-control /var/log/awf-enclave
USER root
ENTRYPOINT ["node", "/opt/awf/enclave/mcp-server/server.js"]
