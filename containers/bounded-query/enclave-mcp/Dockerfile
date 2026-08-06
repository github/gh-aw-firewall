# AWF unified enclave MCP server image.
#
# This image owns the Docker socket and the private seed/work/audit mounts for
# *both* enclave executors, and its Compose service always runs with
# only the dedicated internal MCP control network. It has no `awf-net`, enclave
# executor network, Squid, host gateway, published port, or external egress. Its
# only caller-facing surface is authenticated streamable HTTP through mcpg.
#
# BUILD CONTEXT: `containers/` (not `containers/bounded-query/`).  The server
# drives two audited executors that live in two directories:
#
#   * the bounded-script sandbox pipeline under `containers/bounded-query/`
#   * the bounded-agent enclave pipeline under `containers/bounded-agent/`
#
# A wider context is preferred over duplicating a security-critical
# implementation into a third source tree.
#
#   docker build -f bounded-query/enclave-mcp/Dockerfile containers/
#
# The executor sandboxes themselves are separate, minimal images
# (`enclave-script`, `enclave-agent`); nothing in this image ever executes
# caller-supplied code.

FROM node:22.23.2-alpine3.24 AS enclave-mcp-server

# docker-cli — used by the server to launch single-use executor containers.
RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker

WORKDIR /opt/awf/enclave-mcp

# Shared bounded-execution foundation (finite schema algebra, bit charge,
# strict JSON parsing/canonicalization, fixed timing buckets, protected audit,
# seed-map parsing, sensitivity policy and ledger).
COPY bounded-query/bounded-execution/ /opt/awf/bounded-execution/
# Bounded-script executor pipeline (workspace, runner, runner spec, runtimes).
COPY bounded-query/broker/ /opt/awf/broker/
# Bounded-agent enclave pipeline, reused verbatim from the audited
# bounded-agent broker rather than copied into a second implementation.
COPY bounded-agent/broker/ /opt/awf/agent-broker/
# The MCP protocol/server and the executor adapters.
COPY bounded-query/enclave-mcp/ /opt/awf/enclave-mcp/
# One audited no-network sandbox seccomp profile, pinned for both executors.
COPY bounded-query/query-seccomp.json /opt/awf/query-seccomp.json
COPY bounded-query/query-seccomp.json /opt/awf/enclave-seccomp.json

RUN rm -f /opt/awf/enclave-mcp/Dockerfile \
    && chmod -R a-w /opt/awf \
    && node --check /opt/awf/enclave-mcp/config.js \
    && node --check /opt/awf/enclave-mcp/mcp-protocol.js \
    && node --check /opt/awf/enclave-mcp/agent-executor.js \
    && node --check /opt/awf/enclave-mcp/server.js \
    && node --check /opt/awf/enclave-mcp/healthcheck.js \
    && node --check /opt/awf/broker/broker.js \
    && node --check /opt/awf/broker/query-runner.js \
    && node --check /opt/awf/broker/query-runner-spec.js \
    && node --check /opt/awf/broker/workspace.js \
    && node --check /opt/awf/agent-broker/enclave-runner.js \
    && node --check /opt/awf/agent-broker/enclave-runner-spec.js \
    && node --check /opt/awf/agent-broker/docker-enclave-runner.js \
    && node --check /opt/awf/agent-broker/gvisor-enclave-runner.js \
    && node --check /opt/awf/agent-broker/framing.js \
    && node --check /opt/awf/agent-broker/workspace.js \
    && node --check /opt/awf/bounded-execution/finite-disclosure.js \
    && node --check /opt/awf/bounded-execution/sensitivity-ledger.js \
    && node --check /opt/awf/bounded-execution/fixed-timing.js \
    && node --check /opt/awf/bounded-execution/protected-audit.js \
    && node --check /opt/awf/bounded-execution/repository-staging.js \
    && node -e "require('/opt/awf/enclave-mcp/agent-executor.js')"

# Fixed server-only mount points.
RUN mkdir -p /srv/awf/seeds /srv/awf/work \
      /run/awf-enclave-mcp /run/awf-enclave-mcp-control /var/log/awf-enclave

# The server is root only to copy host-owned read-only seeds into private
# workspaces and hand those workspaces to the unprivileged executor uid.
# Compose keeps the default capability set dropped and restores only those
# filesystem duties.
USER root

ENTRYPOINT ["node", "/opt/awf/enclave-mcp/server.js"]
