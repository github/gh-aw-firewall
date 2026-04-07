#!/bin/sh
# Healthcheck for the CLI proxy sidecar
# Verifies the HTTP server is responsive
curl -sf --max-time 3 http://localhost:11000/health > /dev/null
