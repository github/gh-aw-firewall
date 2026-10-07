FROM node:22-alpine

WORKDIR /opt/awf-enclave-live-gateway
COPY scripts/ci/cloud-hypervisor-enclave-gateway.js ./gateway.js
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/awf-enclave-live-gateway/gateway.js"]
