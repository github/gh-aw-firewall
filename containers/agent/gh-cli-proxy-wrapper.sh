#!/bin/sh
# /usr/local/bin/gh-cli-proxy-wrapper
# Forwards gh CLI invocations to the CLI proxy sidecar over HTTP.
# This wrapper is installed at /usr/local/bin/gh in the agent container
# when --difc-proxy-host is active, so it takes precedence over any
# host-mounted gh binary at /host/usr/bin/gh.
#
# Dependencies: curl, jq (both available in the agent container)

CLI_PROXY="${AWF_CLI_PROXY_URL:-http://172.30.0.50:11000}"

# Build JSON array from all positional arguments without treating embedded
# newlines as argument separators.
ARGS_JSON=$(jq -n '$ARGS.positional' --args -- "$@")

# Capture working directory
CWD=$(pwd)

# Read stdin only when gh is explicitly told to consume it.
STDIN_DATA=""
PREVIOUS_ARG=""
for ARG in "$@"; do
  case "$ARG" in
    --input=-|--body-file=-|--notes-file=-|*=@-) STDIN_DATA=$(base64 | tr -d '\n'); break ;;
  esac
  case "$PREVIOUS_ARG" in
    --input|--body-file|--notes-file)
      if [ "$ARG" = "-" ]; then
        STDIN_DATA=$(base64 | tr -d '\n')
        break
      fi
      ;;
  esac
  PREVIOUS_ARG="$ARG"
done

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
if [ "$CURL_EXIT" -ne 0 ]; then
  rm -f "$RESPONSE_FILE"
  echo "gh: CLI proxy unavailable at ${CLI_PROXY} (curl exit ${CURL_EXIT})" >&2
  exit 1
fi

# Surface policy errors (403), request errors (400/413), and server errors (5xx)
if [ "$HTTP_STATUS" != "200" ]; then
  ERROR=$(jq -r '.error // empty' "$RESPONSE_FILE" 2>/dev/null)
  rm -f "$RESPONSE_FILE"
  if [ -n "$ERROR" ]; then
    echo "gh: ${ERROR}" >&2
  else
    echo "gh: CLI proxy returned HTTP ${HTTP_STATUS}" >&2
  fi
  exit 1
fi

# Extract and emit stdout/stderr from a successful 200 response
EXIT_CODE=$(jq -r '.exitCode // 1' "$RESPONSE_FILE" 2>/dev/null)
case "$EXIT_CODE" in
  ''|*[!0-9]*) EXIT_CODE=1 ;;
esac

jq -j '.stdout // empty' "$RESPONSE_FILE"
jq -j '.stderr // empty' "$RESPONSE_FILE" >&2
rm -f "$RESPONSE_FILE"
exit "${EXIT_CODE:-1}"
