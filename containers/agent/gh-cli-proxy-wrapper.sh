#!/bin/sh
# /usr/local/bin/gh-cli-proxy-wrapper
# Forwards gh CLI invocations to the CLI proxy sidecar over HTTP.
# This wrapper is installed at /usr/local/bin/gh in the agent container
# when --enable-cli-proxy is active, so it takes precedence over any
# host-mounted gh binary at /host/usr/bin/gh.
#
# Dependencies: curl, jq (both available in the agent container)
set -e

CLI_PROXY="${AWF_CLI_PROXY_URL:-http://172.30.0.50:11000}"

# Build JSON array from all positional arguments
ARGS_JSON='[]'
if [ $# -gt 0 ]; then
  ARGS_JSON=$(printf '%s\n' "$@" | jq -R . | jq -s .)
fi

# Capture working directory
CWD=$(pwd)

# Read stdin if data is available (non-interactive)
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat | base64 | tr -d '\n')
fi

# Send the request to the CLI proxy
RESPONSE=$(curl -sf \
  --max-time 60 \
  -X POST "${CLI_PROXY}/exec" \
  -H "Content-Type: application/json" \
  --data-binary "$(printf '{"args":%s,"cwd":%s,"stdin":"%s"}' \
    "$ARGS_JSON" \
    "$(printf '%s' "$CWD" | jq -Rs .)" \
    "$STDIN_DATA")")

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "gh: CLI proxy unavailable at ${CLI_PROXY}" >&2
  exit 1
fi

# Extract and emit stdout/stderr
STDOUT=$(printf '%s' "$RESPONSE" | jq -r '.stdout // empty' 2>/dev/null)
STDERR=$(printf '%s' "$RESPONSE" | jq -r '.stderr // empty' 2>/dev/null)
EXIT_CODE=$(printf '%s' "$RESPONSE" | jq -r '.exitCode // 1' 2>/dev/null)

# Check for error response (403 blocked, 404, 500)
ERROR=$(printf '%s' "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$ERROR" ]; then
  echo "gh: ${ERROR}" >&2
  exit 1
fi

printf '%s' "$STDOUT"
printf '%s' "$STDERR" >&2
exit "${EXIT_CODE:-1}"
