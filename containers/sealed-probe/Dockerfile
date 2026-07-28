# Sealed-probe image — multi-stage build producing two images:
#
#  1. `probe` stage  — minimal Python 3-only sandbox rootfs published as
#     `sealed-probe:*`.  The probe process gets none of the broker's tools:
#     no Node runtime, no docker-cli, no Alpine package manager.  The probe
#     runs --read-only, --network none, --cap-drop ALL, unprivileged (UID
#     65534), and with a restrictive seccomp profile, so the absence of
#     those binaries is defence-in-depth rather than the primary control.
#
#  2. `broker` (default) stage — published as `sealed-probe-broker:*`.
#     Has Node + docker-cli to run the server and launch probe containers.
#
# Using two images keeps the probe environment minimal while still
# guaranteeing the probe image is local when the broker starts: the release
# workflow builds and pushes both tags, and the compose service pulls the
# broker image, which is declared as depending on the probe image being
# present (verified by assertProbeImageAvailable before the first request).

# ──────────────────────────────────────────────────────────────────────────
# probe stage: Python 3 standard-library-only sandbox rootfs.
# No Node, no docker-cli, no apk package manager.
# ──────────────────────────────────────────────────────────────────────────
FROM python:3.12-alpine3.21 AS probe

RUN python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/bin/python3

# Pre-create mount points used by the probe container so a missing bind
# mount fails loudly rather than silently materialising an empty directory.
RUN mkdir -p /probe /awf

# ──────────────────────────────────────────────────────────────────────────
# broker stage: trusted broker with Node + docker-cli (default build target)
# ──────────────────────────────────────────────────────────────────────────
FROM node:22.23.1-alpine3.24

# docker-cli  — used by the broker to launch probe containers
RUN apk add --no-cache docker-cli \
    && test -x /usr/bin/docker

WORKDIR /opt/awf/broker
COPY broker/ /opt/awf/broker/
COPY probe-seccomp.json /opt/awf/probe-seccomp.json

RUN chmod -R a-w /opt/awf \
    && node --check /opt/awf/broker/server.js \
    && node --check /opt/awf/broker/broker.js \
    && node --check /opt/awf/broker/protocol.js \
    && node --check /opt/awf/broker/framing.js \
    && node --check /opt/awf/broker/workspace.js \
    && node --check /opt/awf/broker/probe-runner.js \
    && node --check /opt/awf/broker/healthcheck.js

# Fixed broker-only mount points.
RUN mkdir -p /srv/awf/seeds /srv/awf/work /run/awf-sealed-probe /var/log/awf-sealed-probe

# The broker is root only to copy host-owned read-only seeds into private
# workspaces and hand those workspaces to the unprivileged probe uid.
# Keep the default set dropped and restore only those filesystem duties.
USER root

ENTRYPOINT ["node", "/opt/awf/broker/server.js"]
