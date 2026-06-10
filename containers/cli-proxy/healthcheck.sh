#!/bin/sh
# Healthcheck for the CLI proxy sidecar
# 1. Verifies the HTTP server is responsive
# 2. Verifies the DIFC proxy TCP tunnel is still reachable (fail-fast for Docker-unavailable cases)
#    so that Docker marks the container unhealthy when the external DIFC proxy goes away,
#    allowing awf's depends_on: service_healthy to propagate the failure to the agent container.
curl -sf --max-time 3 http://127.0.0.1:11000/health > /dev/null && \
  timeout 3 bash -c "cat < /dev/null > /dev/tcp/${AWF_DIFC_PROXY_HOST:-host.docker.internal}/${AWF_DIFC_PROXY_PORT:-18443}" 2>/dev/null
