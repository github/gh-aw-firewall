# Bounded-query image — multi-stage build producing two images:
#
#  1. `query` stage  — minimal Python 3-only sandbox rootfs published as
#     `bounded-query:*`.  The query process gets none of the broker's tools:
#     no Node runtime, no docker-cli, no Alpine package manager.  The query
#     runs --read-only, --network none, --cap-drop ALL, unprivileged (UID
#     65534), and with a restrictive seccomp profile, so the absence of
#     those binaries is defence-in-depth rather than the primary control.
#
#  2. `broker` (default) stage — published as `bounded-query-broker:*`.
#     Has Node + docker-cli to run the server and launch query containers.
#
# Using two images keeps the query environment minimal while still
# guaranteeing the query image is local when the broker starts: the release
# workflow builds and pushes both tags, and the compose service pulls the
# broker image, which is declared as depending on the query image being
# present (verified by assertQueryImageAvailable before the first request).

# ──────────────────────────────────────────────────────────────────────────
# query stage: Python 3 standard-library-only sandbox rootfs.
# No Node, no docker-cli, no apk package manager.
# ──────────────────────────────────────────────────────────────────────────
FROM python:3.12-alpine3.21 AS query

RUN python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/local/bin/python3 \
    && rm -f /sbin/apk

COPY query-entrypoint.py /usr/local/bin/run-query
RUN chmod 0555 /usr/local/bin/run-query

# Pre-create mount points used by the query container so a missing bind
# mount fails loudly rather than silently materialising an empty directory.
RUN mkdir -p /query /awf/seed

# ──────────────────────────────────────────────────────────────────────────
# broker stage: trusted broker with Node + docker-cli (default build target)
# ──────────────────────────────────────────────────────────────────────────
FROM node:22.23.1-alpine3.24 AS broker

# docker-cli  — used by the broker to launch query containers
RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker

WORKDIR /opt/awf/broker
COPY broker/ /opt/awf/broker/
COPY query-seccomp.json /opt/awf/query-seccomp.json

RUN chmod -R a-w /opt/awf \
    && node --check /opt/awf/broker/server.js \
    && node --check /opt/awf/broker/broker.js \
    && node --check /opt/awf/broker/protocol.js \
    && node --check /opt/awf/broker/framing.js \
    && node --check /opt/awf/broker/workspace.js \
    && node --check /opt/awf/broker/query-runner.js \
    && node --check /opt/awf/broker/query-runner-spec.js \
    && node --check /opt/awf/broker/docker-client.js \
    && node --check /opt/awf/broker/docker-query-runner.js \
    && node --check /opt/awf/broker/gvisor-query-runner.js \
    && node --check /opt/awf/broker/healthcheck.js

# Fixed broker-only mount points.
RUN mkdir -p /srv/awf/seeds /srv/awf/work /run/awf-bounded-query /run/awf-bounded-query-control /var/log/awf-bounded-query

# The broker is root only to copy host-owned read-only seeds into private
# workspaces and hand those workspaces to the unprivileged query uid.
# Keep the default set dropped and restore only those filesystem duties.
USER root

ENTRYPOINT ["node", "/opt/awf/broker/server.js"]
