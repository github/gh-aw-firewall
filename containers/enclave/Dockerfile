# AWF enclave images. Build context: containers/.

FROM python:3.12-alpine3.21 AS enclave-script

RUN python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && rm -f /sbin/apk
COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script
RUN chmod 0555 /usr/local/bin/run-enclave-script \
    && mkdir -p /script /awf/seed

FROM node:24-bookworm-slim AS enclave-agent

ARG COPILOT_CLI_VERSION=1.0.34
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git python3 ripgrep \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && npm_config_ignore_scripts=false npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
    && rm -rf /usr/local/lib/node_modules/@github/copilot-linux-* \
    && ln -sf ../lib/node_modules/@github/copilot/index.js /usr/local/bin/copilot \
    && node --version | grep -qE '^v24\.' \
    && copilot --version | grep -q "GitHub Copilot CLI ${COPILOT_CLI_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache \
             /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent
RUN chmod 0555 /usr/local/bin/run-enclave-agent \
    && python3 -m py_compile /usr/local/bin/run-enclave-agent \
    && rm -rf /usr/local/bin/__pycache__ \
    && mkdir -p /agent /awf/seed

FROM node:22.23.1-alpine3.24 AS enclave-mcp-server

RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker
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
