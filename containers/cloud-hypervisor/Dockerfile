# Cloud Hypervisor-only guest images. ARC/DinD continues to use build-tools.
# Build context: containers/. Release builds pass digest-pinned image arguments.
ARG GUEST_BASE_IMAGE=awf-cloud-hypervisor-guest-base:build
ARG BUILD_TOOLS_IMAGE=awf-build-tools
ARG ENCLAVE_AGENT_IMAGE=awf-enclave-agent

FROM node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0 AS node-runtime
FROM ${BUILD_TOOLS_IMAGE} AS build-tools
FROM ${ENCLAVE_AGENT_IMAGE} AS copilot-runtime

FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944 AS guest-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates python3 bash coreutils findutils grep sed gawk \
      tar gzip bzip2 xz-utils unzip zip curl wget git jq iproute2 \
      libatomic1 libcap2-bin gosu libstdc++6 libicu-dev libssl-dev \
      libsqlite3-dev libffi-dev zlib1g-dev \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY trust/ /opt/awf/trust/
RUN sh /opt/awf/trust/install-system-trust.sh \
    && sh /opt/awf/trust/install-node-trust.sh
COPY --from=supervisor /awf-supervisor /usr/sbin/awf-supervisor
RUN chmod 0755 /usr/sbin/awf-supervisor \
    && mkdir -p /awf/seed /awf/out /dev/shm /proc /sys /tmp \
    && chmod 01777 /tmp \
    && test -r /etc/ssl/certs/ca-certificates.crt \
    && python3 -c 'import json, pathlib, runpy' \
    && test -x /usr/sbin/awf-supervisor \
    && node --version

FROM ${GUEST_BASE_IMAGE} AS primary
ARG GUEST_BASE_IMAGE
ARG BUILD_TOOLS_IMAGE
LABEL org.opencontainers.image.base.name="${GUEST_BASE_IMAGE}"
# Keep the existing build-tools sysroot's toolchain and reviewed gh build
# available to the primary guest without changing the ARC/DinD image itself.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential gcc g++ make cmake autoconf automake libtool \
      pkg-config binutils bison flex m4 \
      libssl-dev libc6-dev libicu-dev libsqlite3-dev zlib1g-dev \
      libcurl4-openssl-dev libffi-dev libreadline-dev libyaml-dev \
      libxml2-dev libxslt1-dev libbz2-dev liblzma-dev \
      libncurses5-dev libgdbm-dev libgdbm-compat-dev \
      libgdiplus libev-dev dnsutils net-tools netcat-openbsd gnupg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build-tools /usr/bin/gh /usr/bin/gh
RUN sh /opt/awf/trust/install-system-trust.sh
RUN test -x /usr/bin/gh && gcc --version && make --version \
    && python3 -c 'import json, pathlib, runpy' \
    && node --version

FROM ${GUEST_BASE_IMAGE} AS enclave
ARG GUEST_BASE_IMAGE
ARG ENCLAVE_AGENT_IMAGE
LABEL org.opencontainers.image.base.name="${GUEST_BASE_IMAGE}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=copilot-runtime /usr/local/lib/node_modules/@github/copilot/ /usr/local/lib/node_modules/@github/copilot/
COPY --from=copilot-runtime /usr/bin/gh /usr/bin/gh
RUN sh /opt/awf/trust/install-system-trust.sh
COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script
COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent
RUN sed -i '1c#!/usr/local/bin/node' /usr/local/lib/node_modules/@github/copilot/npm-loader.js \
    && ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot \
    && chmod 0555 /usr/local/bin/run-enclave-script /usr/local/bin/run-enclave-agent \
    && python3 -m py_compile /usr/local/bin/run-enclave-script /usr/local/bin/run-enclave-agent \
    && rm -rf /usr/local/bin/__pycache__ /root/.cache /root/.npm \
    && mkdir -p /agent /query /run/awf-enclave-github \
    && copilot --version
