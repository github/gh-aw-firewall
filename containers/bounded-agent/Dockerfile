# Bounded-agent image — multi-stage build producing engine and broker images:
#
#  1. Engine stages — `enclave-copilot` is published as
#     `bounded-agent-copilot:*` and contains the pinned native Copilot CLI plus
#     its AWF result adapter. The legacy `enclave` stage remains available for
#     compatibility but is not selected by a native engine. Every enclave runs
#     --read-only, --cap-drop ALL, unprivileged (UID 65534), with a seccomp
#     profile and memory/CPU/PID/file-size bounds, and joins only the dedicated
#     `internal` bounded-agent network whose sole other member is the AWF API
#     proxy — so the absence of those binaries is defence-in-depth rather than
#     the primary control.
#
#  2. `broker` (default) stage — published as `bounded-agent-broker:*`.
#     Has Node + docker-cli to run the server and launch enclave containers.
#     It runs with `network_mode: none` and is never a member of the enclave
#     network.
#
# BUILD CONTEXT: `containers/` (not `containers/bounded-agent/`).  The broker
# reuses the PR1 bounded-execution foundation and the audited sandbox seccomp
# profile that already live under `containers/bounded-query/`, and a wider
# context is preferred over duplicating a security-critical implementation.
#
#   docker build -f bounded-agent/Dockerfile --target broker containers/

# ──────────────────────────────────────────────────────────────────────────
# enclave stage: Python 3 standard-library-only bootstrap.
# No Node, no docker-cli, no apk package manager, no gh, no git.
# ──────────────────────────────────────────────────────────────────────────
FROM python:3.12-alpine3.21 AS enclave

RUN python3 -c 'import json, pathlib, re, urllib.request, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && rm -f /sbin/apk

COPY bounded-agent/enclave-entrypoint.py /usr/local/bin/run-bounded-agent
RUN chmod 0555 /usr/local/bin/run-bounded-agent \
    && python3 -m py_compile /usr/local/bin/run-bounded-agent \
    && rm -rf /usr/local/bin/__pycache__

# Pre-create mount points used by the enclave container so a missing bind
# mount fails loudly rather than silently materialising an empty directory.
RUN mkdir -p /agent /awf/seed

# Native Copilot CLI enclave. The CLI owns its normal built-in tools (including
# shell/bash); the container boundary supplies the read-only seed, bounded
# tmpfs, non-root identity, API-proxy-only network, and finite result adapter.
FROM node:22.23.1-bookworm-slim AS enclave-copilot

ARG COPILOT_CLI_VERSION=1.0.34
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git python3 ripgrep \
    && npm_config_ignore_scripts=false npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
    && copilot --version \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache \
             /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY bounded-agent/copilot-entrypoint.py /usr/local/bin/run-bounded-agent
RUN chmod 0555 /usr/local/bin/run-bounded-agent \
    && python3 -m py_compile /usr/local/bin/run-bounded-agent \
    && rm -rf /usr/local/bin/__pycache__ \
    && mkdir -p /agent /awf/seed

# ──────────────────────────────────────────────────────────────────────────
# broker stage: trusted broker with Node + docker-cli (default build target)
# ──────────────────────────────────────────────────────────────────────────
FROM node:22.23.1-alpine3.24 AS broker

# docker-cli — used by the broker to launch enclave containers
RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker

WORKDIR /opt/awf/broker
COPY bounded-agent/broker/ /opt/awf/broker/
# Shared PR1 bounded-execution foundation, reused verbatim rather than copied
# into a second source tree.
COPY bounded-query/bounded-execution/ /opt/awf/bounded-execution/
# The audited no-network sandbox seccomp profile is reused for the enclave.
COPY bounded-query/query-seccomp.json /opt/awf/enclave-seccomp.json

RUN chmod -R a-w /opt/awf \
    && node --check /opt/awf/broker/server.js \
    && node --check /opt/awf/broker/broker.js \
    && node --check /opt/awf/broker/config.js \
    && node --check /opt/awf/broker/framing.js \
    && node --check /opt/awf/broker/protocol.js \
    && node --check /opt/awf/broker/workspace.js \
    && node --check /opt/awf/broker/enclave-runner.js \
    && node --check /opt/awf/broker/enclave-runner-spec.js \
    && node --check /opt/awf/broker/docker-client.js \
    && node --check /opt/awf/broker/docker-enclave-runner.js \
    && node --check /opt/awf/broker/gvisor-enclave-runner.js \
    && node --check /opt/awf/broker/sbx-client.js \
    && node --check /opt/awf/broker/sbx-capability-probe.js \
    && node --check /opt/awf/broker/sbx-enclave-runner-spec.js \
    && node --check /opt/awf/broker/sbx-enclave-runner.js \
    && node --check /opt/awf/broker/runtime-telemetry.js \
    && node --check /opt/awf/broker/healthcheck.js \
    && node --check /opt/awf/bounded-execution/finite-disclosure.js \
    && node --check /opt/awf/bounded-execution/sensitivity-ledger.js \
    && node --check /opt/awf/bounded-execution/fixed-timing.js \
    && node --check /opt/awf/bounded-execution/protected-audit.js \
    && node --check /opt/awf/bounded-execution/repository-staging.js \
    && node --check /opt/awf/bounded-execution/index.js

# Fixed broker-only mount points.
RUN mkdir -p /srv/awf/seeds /srv/awf/work /run/awf-bounded-agent /run/awf-bounded-agent-control /var/log/awf-bounded-agent

# The broker is root only so it can hand the pre-created result file to the
# unprivileged enclave uid. Keep the default capability set dropped and restore
# only those filesystem duties in compose.
USER root

ENTRYPOINT ["node", "/opt/awf/broker/server.js"]
