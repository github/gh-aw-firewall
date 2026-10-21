FROM node:22-alpine@sha256:ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc

WORKDIR /opt/awf-enclave-live-gateway
COPY scripts/ci/cloud-hypervisor-enclave-gateway.js ./gateway.js
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/awf-enclave-live-gateway/gateway.js"]
