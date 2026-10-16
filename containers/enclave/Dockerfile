# AWF enclave images. Build context: containers/.

FROM python:3.14.8-alpine3.24@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72 AS enclave-script

RUN apk upgrade --no-cache \
    && python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && rm -f /sbin/apk
COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script
RUN chmod 0555 /usr/local/bin/run-enclave-script \
    && mkdir -p /script /awf/seed

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS enclave-agent-build

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
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}"

FROM ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7 AS enclave-agent

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git libatomic1 python3 ripgrep \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache
COPY --from=enclave-agent-build /usr/local/bin/node /usr/local/bin/node
COPY --from=enclave-agent-build /usr/local/lib/node_modules/@github/copilot/ /usr/local/lib/node_modules/@github/copilot/
# Avoid uutils env's executable-name check on shebangs under BuildKit's QEMU.
RUN sed -i '1c#!/usr/local/bin/node' /usr/local/lib/node_modules/@github/copilot/npm-loader.js \
    && ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && node --version | grep -qE '^v26\.' \
    && COPILOT_CLI_VERSION="$(node -p 'require("/usr/local/lib/node_modules/@github/copilot/package.json").version')" \
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}" \
    && rm -f /usr/bin/pebble \
    && rm -rf /root/.cache/copilot
COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent
RUN chmod 0555 /usr/local/bin/run-enclave-agent \
    && python3 -m py_compile /usr/local/bin/run-enclave-agent \
    && rm -rf /usr/local/bin/__pycache__ \
    && mkdir -p /agent /awf/seed /run/awf-enclave-github \
    && ! command -v gh

FROM node:26.11.1-alpine3.24@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS enclave-mcp-server

ARG AWF_SOURCE_REVISION=unavailable

RUN apk upgrade --no-cache \
    && apk add --no-cache docker-cli \
    && test -x /usr/bin/docker \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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
