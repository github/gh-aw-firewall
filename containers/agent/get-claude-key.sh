#!/bin/bash
# API Key Helper for Claude Code
# This script outputs the per-job ephemeral proxy token from AWF_PROXY_TOKEN.
# The token is validated by the api-proxy sidecar on every incoming request.
# The real API key is held exclusively in the api-proxy container.
#
# This approach ensures:
# 1. Claude Code agent never has access to the real API key
# 2. Only api-proxy container holds the real credentials
# 3. All requests to api-proxy carry the ephemeral token (validated per-request)

# Log helper invocation to stderr (stdout is reserved for the API key)
echo "[get-claude-key.sh] API key helper invoked at $(date -Iseconds)" >&2
echo "[get-claude-key.sh] Real authentication via ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-not set}" >&2

if [ -z "${AWF_PROXY_TOKEN}" ]; then
  echo "[get-claude-key.sh] WARNING: AWF_PROXY_TOKEN is not set; using fallback placeholder" >&2
  echo "sk-ant-placeholder-key-for-credential-isolation"
else
  echo "[get-claude-key.sh] Returning AWF_PROXY_TOKEN for proxy authentication" >&2
  echo "${AWF_PROXY_TOKEN}"
fi
