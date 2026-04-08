#!/bin/sh
# /usr/local/bin/gh-cli-proxy-wrapper
# Forwards gh CLI invocations to the CLI proxy sidecar over HTTP.
# This wrapper is installed at /usr/local/bin/gh in the agent container
# when --difc-proxy-host is active, so it takes precedence over any
# host-mounted gh binary at /host/usr/bin/gh.
#
# Dependencies: curl, jq (both available in the agent container)

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

# Use a temporary file to capture the response body without -f,
# so we can read the body even on 4xx/5xx responses (e.g., 403 policy block).
RESPONSE_FILE=$(mktemp)
HTTP_STATUS=$(curl -s \
  --max-time 60 \
  -o "$RESPONSE_FILE" \
  -w "%{http_code}" \
  -X POST "${CLI_PROXY}/exec" \
  -H "Content-Type: application/json" \
  --data-binary "$(printf '{"args":%s,"cwd":%s,"stdin":"%s"}' \
    "$ARGS_JSON" \
    "$(printf '%s' "$CWD" | jq -Rs .)" \
    "$STDIN_DATA")")
CURL_EXIT=$?
RESPONSE=$(cat "$RESPONSE_FILE")
rm -f "$RESPONSE_FILE"

if [ "$CURL_EXIT" -ne 0 ]; then
  echo "gh: CLI proxy unavailable at ${CLI_PROXY} (curl exit ${CURL_EXIT})" >&2
  exit 1
fi

# Surface policy errors (403), request errors (400/413), and server errors (5xx)
if [ "$HTTP_STATUS" != "200" ]; then
  ERROR=$(printf '%s' "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
  if [ -n "$ERROR" ]; then
    echo "gh: ${ERROR}" >&2
  else
    echo "gh: CLI proxy returned HTTP ${HTTP_STATUS}" >&2
  fi
  exit 1
fi

# Extract and emit stdout/stderr from a successful 200 response
STDOUT=$(printf '%s' "$RESPONSE" | jq -r '.stdout // empty' 2>/dev/null)
STDERR=$(printf '%s' "$RESPONSE" | jq -r '.stderr // empty' 2>/dev/null)
EXIT_CODE=$(printf '%s' "$RESPONSE" | jq -r '.exitCode // 1' 2>/dev/null)

printf '%s' "$STDOUT"
printf '%s' "$STDERR" >&2
exit "${EXIT_CODE:-1}"
