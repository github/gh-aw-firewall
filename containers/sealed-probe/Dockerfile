# Sealed-probe image.
#
# Serves two roles:
#
#  1. the trusted sealed-probe **broker** (`network_mode: none`, holds the
#     Docker socket, launches probes); and
#  2. the **probe sandbox** rootfs itself.
#
# Using one image is deliberate: the probe image must already be present on the
# daemon when an invocation happens, because the broker has no network and must
# never pull. Compose pulls/builds this image to start the broker, which
# guarantees it is local before the first probe runs.
#
# The probe process gets none of the broker's privileges: it is launched with
# --network none, --read-only, --user 65534, --cap-drop ALL,
# --security-opt no-new-privileges, a restrictive seccomp profile, and no
# Docker socket, so the node/docker binaries present in this image are inert
# inside a probe.
FROM node:22.23.1-alpine3.24

# python3  — the probe interpreter (standard library only; no pip, no wheels)
# docker-cli — used by the broker to launch probe containers
RUN apk add --no-cache python3 docker-cli \
    && python3 -c 'import json, pathlib, sys; sys.exit(0)' \
    && test -x /usr/bin/python3

# The broker has no dependencies outside the Node standard library, so there is
# no package installation step and no lockfile to drift.
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

# Fixed mount points, created up-front so a missing bind mount fails loudly
# rather than silently materialising an empty directory.
RUN mkdir -p /srv/awf/seeds /srv/awf/work /run/awf-sealed-probe /var/log/awf-sealed-probe /probe /awf

# The broker needs root to talk to the Docker socket and to hand per-invocation
# copies to the unprivileged probe uid. It is otherwise hardened by compose
# (cap_drop ALL, no-new-privileges, no network, resource limits).
USER root

ENTRYPOINT ["node", "/opt/awf/broker/server.js"]
