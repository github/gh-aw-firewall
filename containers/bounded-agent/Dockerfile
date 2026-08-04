# Bounded-agent broker image:
#
# `broker` is published as `bounded-agent-broker:*`.
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
