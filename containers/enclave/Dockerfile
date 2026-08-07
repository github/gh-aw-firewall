# AWF enclave images. Build context: containers/.

FROM python:3.14.7-alpine3.24 AS enclave-script

RUN python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && rm -f /sbin/apk
COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script
RUN chmod 0555 /usr/local/bin/run-enclave-script \
    && mkdir -p /script /awf/seed

FROM node:24.18.1-trixie-slim AS enclave-agent-build

ARG COPILOT_CLI_VERSION=1.0.77
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN npm_config_ignore_scripts=false npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
    && npm_config_ignore_scripts=true npm install \
         --prefix /usr/local/lib/node_modules/@github/copilot \
         --omit=dev adm-zip@0.6.0 \
    && find /usr/local/lib/node_modules/@github/copilot \
         -path '*/foundry-local-sdk/node_modules/adm-zip' -prune -type d \
         -exec sh -c 'rm -rf "$1" && cp -a /usr/local/lib/node_modules/@github/copilot/node_modules/adm-zip "$1"' sh {} \; \
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}"

FROM ubuntu:26.04 AS enclave-agent

ARG COPILOT_CLI_VERSION=1.0.77
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git python3 ripgrep \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache
COPY --from=enclave-agent-build /usr/local/bin/node /usr/local/bin/node
COPY --from=enclave-agent-build /usr/local/lib/node_modules/@github/copilot/ /usr/local/lib/node_modules/@github/copilot/
RUN ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && node --version | grep -qE '^v24\.' \
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}" \
    && rm -rf /root/.cache/copilot
COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent
RUN chmod 0555 /usr/local/bin/run-enclave-agent \
    && python3 -m py_compile /usr/local/bin/run-enclave-agent \
    && rm -rf /usr/local/bin/__pycache__ \
    && mkdir -p /agent /awf/seed

FROM node:22.23.2-alpine3.24 AS enclave-mcp-server

RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /opt/awf/enclave/mcp-server
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
